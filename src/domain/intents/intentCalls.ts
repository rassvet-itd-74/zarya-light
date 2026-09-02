import type { MatrixCoordinate, MatrixKind } from '../matrix/matrix';
import type { PartyOrganTriple } from '../organs/partyOrgan';
import type { EvmAddress } from '../primitives';
import type { VotingId } from '../voting/voting';
import type { DurationSeconds, GovernanceIntent, VoteDirection } from './intent';

/**
 * The contract calls a governance document is allowed to cause.
 *
 * A second closed union, and not a redundant one. `GovernanceIntent` says what a
 * document *asks for*; this says what the contract *takes*, and the two differ in
 * three ways that each need a named place to happen:
 *
 * 1. **Arity.** `CONFIGURE_ORGAN_THRESHOLDS` is one operation and three
 *    transactions, because the three setters have no multicall.
 * 2. **Naming.** A categorical value proposal carries a `category`, and
 *    `createCategoricalValueVoting` takes it as `value`. That rename is the kind
 *    of thing that is silently wrong if it happens inline at an encoder.
 * 3. **Argument order.** `createStatementVoting(bool, x, y, string, uint256)`
 *    takes two `uint256` coordinates in a row, so a swap type-checks, encodes,
 *    and addresses a different cell. Naming them here means the order is asserted
 *    in one test rather than trusted at every call site.
 *
 * ## What is not in it
 *
 * `executeVoting` and `initializeOrgans`. `executeVoting` is the executor's, and
 * hard rule 3 says the executor may call it *and nothing else* — expressing that
 * as two disjoint call types rather than one union with a comment means the form
 * pipeline cannot reach it and the executor cannot reach anything else, by
 * typing. The executor's own call type arrives with the queue; until then it
 * calls the simulator's `executeVoting` arm directly.
 *
 * Everything here stays in **domain vocabulary** — an organ is a triple, a matrix
 * is a `MatrixKind`, a vote is a `VoteDirection`. A domain value becomes a wire
 * value only at the encoder, which is the same rule that keeps a region subject
 * code from having an arithmetic route into an argument.
 */

/**
 * Every write function the form pipeline may reach, as the ABI spells them.
 *
 * Listed rather than derived, and that is deliberate: derived from the ABI it
 * would silently grow when the ABI does, which is exactly the drift the allow
 * list exists to prevent. The encoder's test asserts every name here is a
 * non-`view` function the ABI declares — a list that has to be maintained, and
 * that fails loudly rather than absorbing a new one.
 */
export const ZARYA_WRITE_FUNCTIONS = [
  'createMembershipVoting',
  'createMembershipRevocationVoting',
  'createCategoryVoting',
  'createDecimalsVoting',
  'createThemeVoting',
  'createStatementVoting',
  'createCategoricalValueVoting',
  'createNumericalValueVoting',
  'castVote',
  'setMinimumQuorum',
  'setMinimumApprovalPercentage',
  'setMinimumApprovalPercentageBase',
  'transferChairmanship',
] as const;

export type ZaryaWriteFunction = (typeof ZARYA_WRITE_FUNCTIONS)[number];

export type ZaryaWriteCall =
  | {
      readonly fn: 'createMembershipVoting';
      readonly organ: PartyOrganTriple;
      readonly member: EvmAddress;
      readonly duration: DurationSeconds;
    }
  | {
      readonly fn: 'createMembershipRevocationVoting';
      readonly organ: PartyOrganTriple;
      readonly member: EvmAddress;
      readonly duration: DurationSeconds;
    }
  | {
      readonly fn: 'createCategoryVoting';
      readonly organ: PartyOrganTriple;
      readonly at: MatrixCoordinate;
      readonly category: bigint;
      readonly categoryName: string;
      readonly duration: DurationSeconds;
    }
  | {
      readonly fn: 'createDecimalsVoting';
      readonly organ: PartyOrganTriple;
      readonly at: MatrixCoordinate;
      readonly decimals: number;
      readonly duration: DurationSeconds;
    }
  | {
      readonly fn: 'createThemeVoting';
      readonly matrix: MatrixKind;
      readonly x: bigint;
      readonly theme: string;
      readonly duration: DurationSeconds;
    }
  | {
      readonly fn: 'createStatementVoting';
      readonly matrix: MatrixKind;
      readonly at: MatrixCoordinate;
      readonly statement: string;
      readonly duration: DurationSeconds;
    }
  /**
   * `value` rather than `category`, because that is the argument's name and this
   * is the layer that speaks the contract's vocabulary. On a categorical cell the
   * stored value *is* a category id; the rename happens once, here.
   */
  | {
      readonly fn: 'createCategoricalValueVoting';
      readonly organ: PartyOrganTriple;
      readonly at: MatrixCoordinate;
      readonly value: bigint;
      readonly valueAuthor: EvmAddress;
      readonly duration: DurationSeconds;
    }
  | {
      readonly fn: 'createNumericalValueVoting';
      readonly organ: PartyOrganTriple;
      readonly at: MatrixCoordinate;
      /** Already scaled. The scale is not an argument — it is stored per cell. */
      readonly value: bigint;
      readonly valueAuthor: EvmAddress;
      readonly duration: DurationSeconds;
    }
  | {
      readonly fn: 'castVote';
      readonly votingId: VotingId;
      readonly direction: VoteDirection;
    }
  | { readonly fn: 'setMinimumQuorum'; readonly organ: PartyOrganTriple; readonly value: bigint }
  | {
      readonly fn: 'setMinimumApprovalPercentage';
      readonly organ: PartyOrganTriple;
      readonly value: bigint;
    }
  | {
      readonly fn: 'setMinimumApprovalPercentageBase';
      readonly organ: PartyOrganTriple;
      readonly value: bigint;
    }
  | { readonly fn: 'transferChairmanship'; readonly newChairman: EvmAddress };

/** The organ a call names, when it names one. `undefined` is a real answer. */
export function organOfCall(call: ZaryaWriteCall): PartyOrganTriple | undefined {
  switch (call.fn) {
    case 'createMembershipVoting':
    case 'createMembershipRevocationVoting':
    case 'createCategoryVoting':
    case 'createDecimalsVoting':
    case 'createCategoricalValueVoting':
    case 'createNumericalValueVoting':
    case 'setMinimumQuorum':
    case 'setMinimumApprovalPercentage':
    case 'setMinimumApprovalPercentageBase':
      return call.organ;
    case 'createThemeVoting':
    case 'createStatementVoting':
    case 'castVote':
    case 'transferChairmanship':
      return undefined;
  }
}

/**
 * The calls that carry out an intent, in the order they must be sent.
 *
 * A non-empty tuple, so a caller never has to handle "an intent that expands to
 * nothing" — there is no such intent and the type says so.
 */
export type CallSequence = readonly [ZaryaWriteCall, ...ZaryaWriteCall[]];

/**
 * The only route from an intent to a call, exhaustive over the union.
 *
 * The `default` arm is unreachable and exists to make a twelfth variant a
 * compile error here: `assertNever` accepts `never`, so an unhandled member of
 * the union fails to assign. Ten intents map one-to-one; the eleventh is below.
 */
export function callsForIntent(intent: GovernanceIntent): CallSequence {
  switch (intent.type) {
    case 'CREATE_MEMBERSHIP_VOTING':
      return [
        {
          fn: 'createMembershipVoting',
          organ: intent.organ,
          member: intent.member,
          duration: intent.duration,
        },
      ];

    case 'CREATE_MEMBERSHIP_REVOCATION_VOTING':
      return [
        {
          fn: 'createMembershipRevocationVoting',
          organ: intent.organ,
          member: intent.member,
          duration: intent.duration,
        },
      ];

    case 'CREATE_CATEGORY_VOTING':
      return [
        {
          fn: 'createCategoryVoting',
          organ: intent.organ,
          at: intent.at,
          category: intent.category,
          categoryName: intent.categoryName,
          duration: intent.duration,
        },
      ];

    case 'CREATE_DECIMALS_VOTING':
      return [
        {
          fn: 'createDecimalsVoting',
          organ: intent.organ,
          at: intent.at,
          decimals: intent.decimals,
          duration: intent.duration,
        },
      ];

    case 'CREATE_THEME_VOTING':
      return [
        {
          fn: 'createThemeVoting',
          matrix: intent.matrix,
          x: intent.x,
          theme: intent.theme,
          duration: intent.duration,
        },
      ];

    case 'CREATE_STATEMENT_VOTING':
      return [
        {
          fn: 'createStatementVoting',
          matrix: intent.matrix,
          at: intent.at,
          statement: intent.statement,
          duration: intent.duration,
        },
      ];

    case 'CREATE_CATEGORICAL_VALUE_VOTING':
      return [
        {
          fn: 'createCategoricalValueVoting',
          organ: intent.organ,
          at: intent.at,
          // The rename. Nothing downstream sees a `category` on this branch.
          value: intent.category,
          valueAuthor: intent.valueAuthor,
          duration: intent.duration,
        },
      ];

    case 'CREATE_NUMERICAL_VALUE_VOTING':
      // `intent.decimals` is deliberately not carried into the call: the
      // contract has no argument for it, and preflight has already compared it
      // against the cell. Passing it further would suggest it is being sent.
      return [
        {
          fn: 'createNumericalValueVoting',
          organ: intent.organ,
          at: intent.at,
          value: intent.value,
          valueAuthor: intent.valueAuthor,
          duration: intent.duration,
        },
      ];

    case 'CAST_VOTE':
      // `intent.voting` is a single-arm union today. When the second arm lands,
      // this line stops compiling — which is the review it deserves, since a
      // symbolic reference cannot become a `uint256` without an earlier
      // transaction's receipt.
      return [{ fn: 'castVote', votingId: intent.voting.votingId, direction: intent.direction }];

    case 'CONFIGURE_ORGAN_THRESHOLDS':
      return thresholdCalls(intent);

    case 'TRANSFER_CHAIRMANSHIP':
      return [{ fn: 'transferChairmanship', newChairman: intent.newChairman }];

    default:
      return assertNever(intent);
  }
}

/**
 * The three threshold setters, ordered so that the state visible between the
 * transactions is a *complete* configuration wherever that is achievable.
 *
 * ## Why the order matters at all
 *
 * Eligibility is snapshotted **at voting creation**, not read at execution:
 * `_getEligibilityParams` is called by each `create*Voting` and its three values
 * are copied into the voting (`Zarya.sol:497-503`, `Zarya.sol:512-556`). So a
 * voting created between two of these transactions keeps the half-applied
 * thresholds *for its whole life*, and no getter exists to notice. The window is
 * short; the consequence is permanent.
 *
 * ## The rule
 *
 * The base doubles as the enable flag — a zero base makes
 * `_getEligibilityParams` return `simpleMajority` and ignore the other two
 * entirely (`Zarya.sol:502`).
 *
 * - **Target base zero** — the deliberate reset. The base goes **first**: from
 *   that transaction on, the organ reads as `simpleMajority`, which is the
 *   intended end state, and the two writes that follow are inert. No window.
 *   They are still sent, so that a later base-only configuration does not
 *   resurrect a quorum nobody asked for.
 * - **Target base non-zero.** The base goes **last**, so the quorum and the
 *   approval are written while they are still ignored and the whole
 *   configuration becomes live in one transaction. That is exact for an organ
 *   currently on the fallback, which is every organ that has never been
 *   configured.
 *
 * ## What this ordering does not fix
 *
 * Raising thresholds on an organ that **already** has a non-zero base. There the
 * first transaction changes what a new voting snapshots, and no ordering of
 * three writes avoids it — the only fix is a fourth transaction zeroing the base
 * first, so that every intermediate state is `simpleMajority`. That is not done
 * here: it trades a mixed configuration for a temporary *downgrade* to the
 * default, and which of those is worse is a governance decision rather than a
 * dispatch one. Recorded in `CONTRACT_DEFECTS.md`.
 */
function thresholdCalls(intent: {
  readonly organ: PartyOrganTriple;
  readonly quorum: bigint;
  readonly approvalPercentage: bigint;
  readonly approvalPercentageBase: bigint;
}): CallSequence {
  const { organ } = intent;
  const quorum = { fn: 'setMinimumQuorum', organ, value: intent.quorum } as const;
  const approval = {
    fn: 'setMinimumApprovalPercentage',
    organ,
    value: intent.approvalPercentage,
  } as const;
  const base = {
    fn: 'setMinimumApprovalPercentageBase',
    organ,
    value: intent.approvalPercentageBase,
  } as const;

  return intent.approvalPercentageBase === 0n
    ? [base, quorum, approval]
    : [quorum, approval, base];
}

/**
 * Compile-time exhaustiveness. Reached only if the union gained a variant, in
 * which case the argument is not `never` and this call is a type error.
 */
function assertNever(value: never): never {
  throw new TypeError(`unhandled intent: ${JSON.stringify(value)}`);
}
