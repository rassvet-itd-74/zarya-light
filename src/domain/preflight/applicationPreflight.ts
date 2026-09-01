import {
  type AxisLabel,
  type CategoricalCell,
  type NumericalCell,
  bindingAccepts,
} from '../matrix/matrix';
import type { Bytes32 } from '../primitives';
import type { SuggestionType } from '../voting/voting';
import type { PreflightWarning } from './verdict';

/**
 * Whether a proposal will still be *applicable* when it is executed.
 *
 * This is the check nothing else in the system performs, and the reason it has
 * to exist is an ordering in `Votings.executeVoting`:
 *
 * ```solidity
 * if (success) {
 *     _executeApprovedSuggestion(self, membersRegistry, matricies);   // Votings.sol:439
 * }
 * self.finalized = true;                                             // Votings.sol:442
 * ```
 *
 * The mutation runs **before** the voting is marked finalized. If applying it
 * reverts — `NoThemeSet`, `NoStatementSet`, `InvalidCategory`, `InvalidOrgan`,
 * `CategoryAlreadyExists` — the whole transaction reverts and `finalized` stays
 * false. The voting is then past its deadline, has met quorum, and has *passed*,
 * and every future `executeVoting` reverts identically. See "An approved voting
 * can be permanently unexecutable" in `CONTRACT_DEFECTS.md`.
 *
 * None of these conditions is checked when the voting is created — creation
 * checks organ membership and nothing else. So the moment a client can prevent
 * this is the moment a member fills in the form, and these are the checks that
 * do it.
 *
 * They are **warnings, not blockers**: the creating transaction will succeed,
 * and the state they read can change before execution — another voting may set
 * the missing theme in the meantime. Refusing the call would be stricter than
 * the contract. Telling the member is not.
 */

/**
 * Which suggestion types can fail while being applied.
 *
 * Exhaustive with no default arm. Membership and revocation call
 * `EnumerableSet.add` / `.remove` and ignore the return, so they cannot revert;
 * `setTheme` is a bare assignment (`Matricies.sol:164-166`).
 */
export function canFailAtApplication(type: SuggestionType): boolean {
  switch (type) {
    case 'Membership':
    case 'MembershipRevocation':
    case 'Theme':
      return false;
    case 'Statement':
    case 'Category':
    case 'Decimals':
    case 'CategoricalValue':
    case 'NumericalValue':
      return true;
  }
}

const UNREAD: PreflightWarning = {
  code: 'PRECONDITION_UNREAD',
  summary:
    'A matrix read did not answer, so it is unknown whether this proposal could be applied once it passes.',
};

const noTheme = (): PreflightWarning => ({
  code: 'NO_THEME_AT_COLUMN',
  predicted: 'NoThemeSet',
  summary:
    'No theme is set for this column yet. If that is still true when the voting ends, it will pass and then be permanently unexecutable.',
});

const noStatement = (): PreflightWarning => ({
  code: 'NO_STATEMENT_AT_ROW',
  predicted: 'NoStatementSet',
  summary:
    'No statement is set for this row yet. If that is still true when the voting ends, it will pass and then be permanently unexecutable.',
});

const boundElsewhere = (): PreflightWarning => ({
  code: 'CELL_BOUND_TO_ANOTHER_ORGAN',
  predicted: 'InvalidOrgan',
  summary:
    'This cell is already bound to a different organ. Binding is permanent, so a proposal from this organ can never be applied to it.',
});

/**
 * A categorical cell bound to another organ reports this, **not**
 * `CELL_BOUND_TO_ANOTHER_ORGAN`, because that is what the contract does — see
 * `categoricalValueWarnings`.
 */
const categoryNotAllowed = (organMismatch: boolean): PreflightWarning => ({
  code: organMismatch ? 'CELL_BOUND_TO_ANOTHER_ORGAN' : 'CATEGORY_NOT_ALLOWED',
  predicted: 'InvalidCategory',
  summary: organMismatch
    ? 'This cell is already bound to a different organ, so this organ’s categories do not apply to it. The proposal would pass and then be unexecutable.'
    : 'This category is not among the ones allowed on this cell. The proposal would pass and then be unexecutable.',
});

/** A theme must exist at `x` before a value or a statement can land anywhere on it. */
export function statementWarnings(theme: AxisLabel | undefined): PreflightWarning[] {
  if (theme === undefined) return [UNREAD];
  // `setStatement` gates on the theme at `x` and then writes to `y`
  // (`Matricies.sol:168-181`) — the only use `x` has.
  return theme.kind === 'UNSET' ? [noTheme()] : [];
}

export interface ValuePreconditions {
  /** The organ the proposal names, which is the one the cell would be bound to. */
  readonly organ: Bytes32;
  /** The theme at `x`, and the statement at `y`. */
  readonly theme: AxisLabel | undefined;
  readonly statement: AxisLabel | undefined;
}

export interface CategoricalValuePreconditions extends ValuePreconditions {
  /** The value being proposed, which for a categorical cell *is* the category. */
  readonly category: bigint;
  readonly cell: CategoricalCell | undefined;
}

/**
 * `Matricies.addValue`, categorical branch, in order.
 *
 * The subtlety worth the separate function: the guard `addValue` applies is the
 * **five-argument** `isCategoryAllowed(self, organ, x, y, category)`, which tests
 * `allowedCategories.contains(category) && cell.organ == organ`
 * (`Matricies.sol:48-61`). The getter this client can call is the
 * **four-argument** one, which tests membership of the set alone
 * (`Matricies.sol:266-277`).
 *
 * So `isCategoryAllowed(x, y, category) == true` does **not** mean the value can
 * be added — the organ half of the real check is invisible to it, and has to be
 * evaluated here from the cell's binding.
 *
 * The same asymmetry makes `InvalidOrgan` unreachable on this branch: an organ
 * mismatch fails the category guard first, so a categorical value proposal
 * against another organ's cell reverts `InvalidCategory`, naming the category
 * rather than the organ that actually caused it.
 */
export function categoricalValueWarnings({
  organ,
  theme,
  statement,
  category,
  cell,
}: CategoricalValuePreconditions): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  if (theme === undefined || statement === undefined || cell === undefined) {
    warnings.push(UNREAD);
  }
  if (theme?.kind === 'UNSET') warnings.push(noTheme());
  if (statement?.kind === 'UNSET') warnings.push(noStatement());

  if (cell !== undefined) {
    const mismatch = !bindingAccepts(cell.binding, organ);
    if (mismatch || !cell.allowedCategories.includes(category)) {
      warnings.push(categoryNotAllowed(mismatch));
    }
  }
  return warnings;
}

export interface NumericalValuePreconditions extends ValuePreconditions {
  readonly cell: NumericalCell | undefined;
}

/** `Matricies.addValue`, numerical branch: theme, statement, then the binding. */
export function numericalValueWarnings({
  organ,
  theme,
  statement,
  cell,
}: NumericalValuePreconditions): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  if (theme === undefined || statement === undefined || cell === undefined) {
    warnings.push(UNREAD);
  }
  if (theme?.kind === 'UNSET') warnings.push(noTheme());
  if (statement?.kind === 'UNSET') warnings.push(noStatement());
  if (cell !== undefined && !bindingAccepts(cell.binding, organ)) {
    warnings.push(boundElsewhere());
  }
  return warnings;
}

/**
 * `Matricies.addCategory`: the binding, then whether the category is already
 * there. No theme or statement is required — a category can be declared on a
 * cell whose axes are still unlabelled.
 */
export function categoryWarnings(
  organ: Bytes32,
  category: bigint,
  cell: CategoricalCell | undefined,
): PreflightWarning[] {
  if (cell === undefined) return [UNREAD];
  const warnings: PreflightWarning[] = [];
  if (!bindingAccepts(cell.binding, organ)) warnings.push(boundElsewhere());
  if (cell.allowedCategories.includes(category)) {
    warnings.push({
      code: 'CATEGORY_ALREADY_EXISTS',
      predicted: 'CategoryAlreadyExists',
      summary:
        'This category is already defined on this cell. The proposal would pass and then be unexecutable.',
    });
  }
  return warnings;
}

/** `Matricies.setDecimals`: the binding, and nothing else. */
export function decimalsWarnings(
  organ: Bytes32,
  cell: NumericalCell | undefined,
): PreflightWarning[] {
  if (cell === undefined) return [UNREAD];
  return bindingAccepts(cell.binding, organ) ? [] : [boundElsewhere()];
}
