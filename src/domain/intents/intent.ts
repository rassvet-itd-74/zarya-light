import type { MatrixCoordinate, MatrixKind } from '../matrix/matrix';
import type { PartyOrganTriple } from '../organs/partyOrgan';
import type { EvmAddress } from '../primitives';
import type { VotingId } from '../voting/voting';

/**
 * Everything a governance document is allowed to ask for.
 *
 * The union is **closed and allow-listed**, and that is the whole security
 * property: a returned PDF is a claim, not a fact (`INVARIANTS.md`, "Form trust
 * boundary"), so the only thing standing between a hostile file and a
 * transaction is that there is no representable intent for anything outside this
 * list. There is deliberately no `CallContract`, no target address, no calldata,
 * no ABI signature and no method name taken from a field — a document cannot
 * name a function, only pick one of eleven operations this client already knows
 * how to perform.
 *
 * `ExecuteVoting` is **not here**, and its absence is enforcement rather than an
 * omission: the executor derives it from chain state and a document must never
 * be able to trigger an irreversible mechanical action. Nothing in the form
 * pipeline can construct it because it does not exist as an intent.
 *
 * ## What an intent is and is not
 *
 * An intent says *what is being asked*. It never says who may ask it — that is
 * `AuthorizationRule` in `domain/preflight/`, evaluated against chain reads, and
 * finally by Solidity. A validated intent is not an authorized one.
 *
 * It also carries no field names. The `zarya.input.*` schema belongs to
 * `adapters/forms/`, which maps names to the domain vocabulary here, so the
 * domain cannot read a form and the form cannot invent a domain concept.
 */

/**
 * The wire value of `zarya.meta.operationType`, and the union's discriminant.
 *
 * One spelling for both, because they are the same fact and two spellings would
 * eventually disagree. It is printed on issued forms and stored in the database,
 * so it is stable vocabulary: renaming one is a form schema version bump.
 */
export const OPERATION_TYPES = [
  'CREATE_MEMBERSHIP_VOTING',
  'CREATE_MEMBERSHIP_REVOCATION_VOTING',
  'CREATE_CATEGORY_VOTING',
  'CREATE_DECIMALS_VOTING',
  'CREATE_THEME_VOTING',
  'CREATE_STATEMENT_VOTING',
  'CREATE_CATEGORICAL_VALUE_VOTING',
  'CREATE_NUMERICAL_VALUE_VOTING',
  'CAST_VOTE',
  'CONFIGURE_ORGAN_THRESHOLDS',
  'TRANSFER_CHAIRMANSHIP',
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];

export const isOperationType = (value: string): value is OperationType =>
  (OPERATION_TYPES as readonly string[]).includes(value);

/**
 * How long a proposed voting runs, in seconds.
 *
 * Kept as a plain number with no bound applied here. The bound is a *client
 * policy* — the contract accepts anything, including zero — and lives in
 * `domain/preflight/durationPolicy.ts` so that a refusal it produces is labelled
 * as this client's and never as something the contract said.
 */
export type DurationSeconds = number;

/**
 * Which voting a vote is about.
 *
 * A single-arm union today, on purpose. A later batch item may need to name a
 * voting an earlier item is about to create, and the honest representation of
 * that is a second arm — `{ kind: 'OPERATION'; operationRef }` — not an
 * unresolved string smuggled into `votingId`. It is not added yet because the
 * form schema has no field to carry it (`zarya-intents`: do not implement
 * symbolic references before the schema defines them), and adding the arm later
 * is a compile error at every consumer, which is exactly the review this
 * deserves.
 */
export type VotingRef = { readonly kind: 'ID'; readonly votingId: VotingId };

export const votingRef = (votingId: VotingId): VotingRef => ({ kind: 'ID', votingId });

/**
 * A vote direction as the form states it.
 *
 * An explicit enum mapped deterministically to the contract's `bool support`,
 * never inferred from free text. `zarya-intents`: never sentiment. The mapping
 * lives in one function so there is a single place to be wrong.
 */
export const VOTE_DIRECTIONS = ['FOR', 'AGAINST'] as const;

export type VoteDirection = (typeof VOTE_DIRECTIONS)[number];

export const isVoteDirection = (value: string): value is VoteDirection =>
  (VOTE_DIRECTIONS as readonly string[]).includes(value);

/** The `bool support` argument. `FOR` is `true`; nothing else is. */
export const supportOf = (direction: VoteDirection): boolean => direction === 'FOR';

interface Proposal {
  /**
   * The proposing organ, as the structured triple — never a label, never a
   * hash. The `bytes32` is produced by the contract's own `pure` helper at the
   * adapter boundary, so a Cyrillic identifier is never hashed here and a region
   * subject code has no numeric route into the argument.
   */
  readonly organ: PartyOrganTriple;
  readonly duration: DurationSeconds;
}

export interface CreateMembershipVotingIntent extends Proposal {
  readonly type: 'CREATE_MEMBERSHIP_VOTING';
  readonly member: EvmAddress;
}

export interface CreateMembershipRevocationVotingIntent extends Proposal {
  readonly type: 'CREATE_MEMBERSHIP_REVOCATION_VOTING';
  readonly member: EvmAddress;
}

export interface CreateCategoryVotingIntent extends Proposal {
  readonly type: 'CREATE_CATEGORY_VOTING';
  readonly at: MatrixCoordinate;
  readonly category: bigint;
  readonly categoryName: string;
}

export interface CreateDecimalsVotingIntent extends Proposal {
  readonly type: 'CREATE_DECIMALS_VOTING';
  readonly at: MatrixCoordinate;
  readonly decimals: number;
}

/**
 * Theme and statement proposals carry **no organ**, matching the contract: they
 * take `bool isCategorical` instead and are open to anyone, snapshotting
 * `simpleMajority`. Giving them an organ field would ask a user to choose
 * something that is not sent.
 */
export interface CreateThemeVotingIntent {
  readonly type: 'CREATE_THEME_VOTING';
  readonly matrix: MatrixKind;
  readonly x: bigint;
  readonly theme: string;
  readonly duration: DurationSeconds;
}

export interface CreateStatementVotingIntent {
  readonly type: 'CREATE_STATEMENT_VOTING';
  readonly matrix: MatrixKind;
  /**
   * Both coordinates, because `setStatement` takes both — but only `y` is the
   * address. `x` is a gate: it must carry a theme, and then the write lands at
   * `statements[isCategorical][y]` (`Matricies.sol:168-181`). Dropping `x` from
   * the intent would lose the gate; treating it as part of the address would
   * misdescribe where the statement goes.
   */
  readonly at: MatrixCoordinate;
  readonly statement: string;
  readonly duration: DurationSeconds;
}

/**
 * On a categorical cell the proposed value **is** a category id, and naming the
 * field `category` rather than `value` is what stops anyone applying a decimal
 * scale to it. There are no decimals on this branch.
 */
export interface CreateCategoricalValueVotingIntent extends Proposal {
  readonly type: 'CREATE_CATEGORICAL_VALUE_VOTING';
  readonly at: MatrixCoordinate;
  readonly category: bigint;
  readonly valueAuthor: EvmAddress;
}

export interface CreateNumericalValueVotingIntent extends Proposal {
  readonly type: 'CREATE_NUMERICAL_VALUE_VOTING';
  readonly at: MatrixCoordinate;
  /** Already scaled by {@link decimals}. The contract stores a bare `uint64`. */
  readonly value: bigint;
  /**
   * The scale `value` was produced with, carried so the intent is
   * self-describing.
   *
   * The contract does not take it — it is stored per cell — which is exactly why
   * it has to travel: a template issued when the cell had two decimals, filled
   * in a week later against a cell that now has four, would otherwise submit a
   * number a hundred times too small with nothing to detect it. Preflight
   * compares this against the cell's current decimals.
   */
  readonly decimals: number;
  readonly valueAuthor: EvmAddress;
}

export interface CastVoteIntent {
  readonly type: 'CAST_VOTE';
  readonly voting: VotingRef;
  /**
   * **No organ field, deliberately.** `castVote(votingId, support)` reads the
   * governing organ from the voting itself, so an organ on a vote form is a
   * field that cannot be honoured and invites a user to believe they are
   * choosing something. See `zarya-intents`, "CastVote authorization".
   */
  readonly direction: VoteDirection;
}

/**
 * All three thresholds, as one intent, because they are not independent.
 *
 * An organ whose `approvalPercentageBase` is zero falls back to `simpleMajority`
 * **in its entirety** (`Zarya.sol:496-504`), so a form that sets only a quorum
 * produces a transaction that succeeds and changes nothing observable — and
 * nothing can read back that it did nothing, because no eligibility getter
 * exists. Modelling these as three intents would make that silent failure the
 * default outcome. See "The approval base doubles as an enable flag" in
 * `CONTRACT_DEFECTS.md`.
 *
 * It is the one intent that is not one transaction. The three setters have no
 * multicall, so it expands to three calls; the ordering that makes that as safe
 * as it can be belongs to the dispatcher.
 *
 * Values are **basis points**, preserved as the contract states them and never
 * normalized to percent.
 */
export interface ConfigureOrganThresholdsIntent {
  readonly type: 'CONFIGURE_ORGAN_THRESHOLDS';
  readonly organ: PartyOrganTriple;
  /** An exact count of votes, never a percentage. */
  readonly quorum: bigint;
  /** Basis points against {@link approvalPercentageBase}. */
  readonly approvalPercentage: bigint;
  /** Also the enable flag. Zero resets the organ to `simpleMajority`. */
  readonly approvalPercentageBase: bigint;
}

export interface TransferChairmanshipIntent {
  readonly type: 'TRANSFER_CHAIRMANSHIP';
  readonly newChairman: EvmAddress;
}

export type GovernanceIntent =
  | CreateMembershipVotingIntent
  | CreateMembershipRevocationVotingIntent
  | CreateCategoryVotingIntent
  | CreateDecimalsVotingIntent
  | CreateThemeVotingIntent
  | CreateStatementVotingIntent
  | CreateCategoricalValueVotingIntent
  | CreateNumericalValueVotingIntent
  | CastVoteIntent
  | ConfigureOrganThresholdsIntent
  | TransferChairmanshipIntent;

/**
 * Where an intent is being submitted, and by whom.
 *
 * Not part of the intent: the same proposal is the same proposal on any chain,
 * and a signer is a fact about a submission. Kept beside it because semantic
 * identity needs both — two identical votes from different wallets are two
 * different operations, and the same vote imported twice is one.
 */
export interface IntentContext {
  readonly chainId: number;
  readonly contractAddress: EvmAddress;
  readonly signer: EvmAddress;
}

/** Whether an intent proposes a voting, as opposed to voting or configuring. */
export const isProposal = (intent: GovernanceIntent): boolean =>
  intent.type.startsWith('CREATE_');

/**
 * The organ an intent names, when it names one.
 *
 * `undefined` is a real answer for four of the eleven: theme and statement
 * proposals have no organ, `CastVote` reads it from the voting, and
 * `TransferChairmanship` acts on the Chairperson organ implicitly. It never
 * means "not supplied".
 */
export function organOf(intent: GovernanceIntent): PartyOrganTriple | undefined {
  switch (intent.type) {
    case 'CREATE_MEMBERSHIP_VOTING':
    case 'CREATE_MEMBERSHIP_REVOCATION_VOTING':
    case 'CREATE_CATEGORY_VOTING':
    case 'CREATE_DECIMALS_VOTING':
    case 'CREATE_CATEGORICAL_VALUE_VOTING':
    case 'CREATE_NUMERICAL_VALUE_VOTING':
    case 'CONFIGURE_ORGAN_THRESHOLDS':
      return intent.organ;
    case 'CREATE_THEME_VOTING':
    case 'CREATE_STATEMENT_VOTING':
    case 'CAST_VOTE':
    case 'TRANSFER_CHAIRMANSHIP':
      return undefined;
  }
}
