import { type ErrorMeaning, type ZaryaErrorName, meaningOf } from '../chain/contractErrors';

/**
 * What preflight concluded, and how sure it is.
 *
 * Preflight is UX, never authorization (`INVARIANTS.md`, "Chain safety"). What
 * it produces is a *prediction*, and this type is shaped so a prediction can
 * never be mistaken for a decision: `BLOCKED` says the call would fail now,
 * `UNDETERMINED` says the client could not tell, and neither is a substitute for
 * the simulation the caller runs anyway.
 *
 * Predictions are expressed as the **revert the contract would raise**, not as
 * new client vocabulary, so the meaning and the user-facing wording come from
 * the error registry that already has them. One place to change a message, and
 * a prediction that can be compared against a real revert.
 */

export type PreflightBlocker =
  // Mirrors of the contract's own guards.
  | 'NOT_AUTHORIZED'
  | 'VOTING_NOT_FOUND'
  | 'VOTING_WINDOW_CLOSED'
  | 'ALREADY_VOTED'
  /**
   * The contract refused for a reason preflight has no specific mirror of. Only
   * a simulation produces this — the client's own checks cover the guards it
   * models, and anything outside them arrives as a real revert or not at all.
   */
  | 'CONTRACT_REFUSED'
  /**
   * A client rule with no contract counterpart. Kept separate from the mirrors
   * above because it is the one kind of refusal that is *stricter* than the
   * chain: the contract accepts any duration, including `0`.
   */
  | 'CLIENT_POLICY';

export type PreflightUnknown =
  /** The voting is not in the projection, so its organ — and eligibility — is unknown. */
  | 'ORGAN_UNKNOWN'
  /** `isMember` did not answer. */
  | 'MEMBERSHIP_UNREAD'
  /** A voting read did not answer. */
  | 'VOTING_UNREAD'
  /** A matrix read did not answer, so a precondition could not be evaluated. */
  | 'MATRIX_UNREAD';

export interface BlockedVerdict {
  readonly kind: 'BLOCKED';
  readonly blocker: PreflightBlocker;
  /**
   * The revert this predicts — **`undefined` when an earlier guard could not be
   * evaluated.** The contract checks in order, so if a check before this one is
   * unread, the call still cannot succeed, but which error it raises is no
   * longer knowable. Saying "it fails" without naming the error is the honest
   * answer there; naming one would be a guess a fork test could catch.
   */
  readonly predicted?: ZaryaErrorName;
  /** Disposition and user-safe wording, from the error registry. */
  readonly meaning: ErrorMeaning;
}

export interface UndeterminedVerdict {
  readonly kind: 'UNDETERMINED';
  readonly reason: PreflightUnknown;
}

export type PreflightVerdict =
  | { readonly kind: 'READY' }
  | BlockedVerdict
  | UndeterminedVerdict;

export const READY: PreflightVerdict = { kind: 'READY' };

export const undetermined = (reason: PreflightUnknown): UndeterminedVerdict => ({
  kind: 'UNDETERMINED',
  reason,
});

export const blocked = (
  blocker: PreflightBlocker,
  predicted: ZaryaErrorName,
  panicCode?: bigint,
): BlockedVerdict => ({
  kind: 'BLOCKED',
  blocker,
  predicted,
  meaning: meaningOf(predicted, panicCode),
});

/**
 * A refusal this client makes on its own authority, with no revert behind it.
 * `disposition` is `REJECTED` because that is exactly what it is: change the
 * request and try again.
 */
export const blockedByPolicy = (summary: string): BlockedVerdict => ({
  kind: 'BLOCKED',
  blocker: 'CLIENT_POLICY',
  meaning: { disposition: 'REJECTED', summary },
});

/**
 * Which blocker a decoded revert corresponds to.
 *
 * The mapping exists so a simulation's answer and the client's own prediction
 * are expressed in the same vocabulary and can be compared. Anything with no
 * mirror is `CONTRACT_REFUSED` rather than being forced into the nearest arm.
 */
export function blockerFor(name: ZaryaErrorName): PreflightBlocker {
  switch (name) {
    case 'NotActiveMember':
    case 'NotChairman':
      return 'NOT_AUTHORIZED';
    case 'VotingNotFound':
      return 'VOTING_NOT_FOUND';
    case 'VotingNotActive':
      return 'VOTING_WINDOW_CLOSED';
    case 'AlreadyVoted':
      return 'ALREADY_VOTED';
    default:
      return 'CONTRACT_REFUSED';
  }
}

/**
 * One guard, in the order the contract evaluates it.
 *
 * `undefined` means "this guard passed"; anything else is what it concluded.
 */
export type PreflightCheck = PreflightVerdict | undefined;

/**
 * Resolves a sequence of guards written in **contract evaluation order**.
 *
 * A definite blocker beats an earlier unknown, because a blocker at any position
 * means the call cannot succeed regardless of what the unknown one would have
 * said. But the predicted error is dropped in that case: the contract would have
 * reverted at the earlier guard if that guard also fails, and this client cannot
 * say which.
 *
 * With no blocker, the first unknown wins — there is nothing further to learn
 * from guards the contract may never reach.
 */
export function resolvePreflight(checks: readonly PreflightCheck[]): PreflightVerdict {
  let firstUnknown: PreflightVerdict | undefined;

  for (const check of checks) {
    if (check === undefined || check.kind === 'READY') continue;
    if (check.kind === 'UNDETERMINED') {
      firstUnknown ??= check;
      continue;
    }
    // A client-policy refusal is not a contract guard, so an unresolved contract
    // guard before it says nothing about it — its wording stays exact.
    if (firstUnknown === undefined || check.blocker === 'CLIENT_POLICY') return check;
    return { kind: 'BLOCKED', blocker: check.blocker, meaning: check.meaning };
  }

  return firstUnknown ?? READY;
}

/**
 * Something that will not stop the call being sent, but will make it pointless.
 *
 * The case that forced this type into existence: the matrix preconditions for a
 * value, category or decimals proposal are **not checked when the voting is
 * created**. They are checked when it executes, days later, after members have
 * voted. So a proposal with no theme at its column is accepted, campaigned for,
 * approved — and then permanently unexecutable. See "An approved voting can be
 * permanently unexecutable" in `CONTRACT_DEFECTS.md`.
 *
 * Every warning here therefore surfaces at execution, never at the call being
 * previewed. That is what separates a warning from a blocker.
 */
export interface PreflightWarning {
  readonly code: PreflightWarningCode;
  /**
   * The revert `executeVoting` would raise once this voting passes. Absent for
   * `PRECONDITION_UNREAD`, which reports a gap in what was checked rather than a
   * predicted failure.
   */
  readonly predicted?: ZaryaErrorName;
  /** One line, safe to show a user. */
  readonly summary: string;
}

export type PreflightWarningCode =
  | 'NO_THEME_AT_COLUMN'
  | 'NO_STATEMENT_AT_ROW'
  | 'CATEGORY_NOT_ALLOWED'
  | 'CELL_BOUND_TO_ANOTHER_ORGAN'
  | 'CATEGORY_ALREADY_EXISTS'
  /** A matrix read did not answer, so a precondition is unchecked rather than met. */
  | 'PRECONDITION_UNREAD';

export interface PreflightReport {
  readonly verdict: PreflightVerdict;
  /** Empty when every precondition was checked and met. */
  readonly warnings: readonly PreflightWarning[];
}
