import type { PartyOrganTriple } from '../organs/partyOrgan';
import {
  type AuthorizationRule,
  CHAIRMAN_ONLY,
  PERMISSIONLESS,
  UNDETERMINED_ORGAN,
  castVoteRule,
} from '../preflight/authorization';
import type { Bytes32 } from '../primitives';
import type { GoverningOrgan } from '../voting/voting';
import type { GovernanceIntent } from './intent';
import { organOf } from './intent';

/**
 * Which guard the contract will apply to each intent.
 *
 * The intent model says **what** is being asked; this says **which rule decides
 * whether it may be**. Keeping them apart is what stops a document acquiring
 * privilege by naming an operation: adding an intent variant does not grant it
 * anything, because the rule is assigned here, by hand, and the mapping is
 * exhaustive so a new variant cannot inherit one by accident.
 *
 * The rules themselves are Phase 2's, read from `Zarya.sol`'s modifiers. Nothing
 * here invents authorization; it only routes.
 */

/**
 * What the caller had to look up before a rule could be assigned.
 *
 * Both are optional and absence is never fatal — it produces
 * `UNDETERMINED_ORGAN`, and preflight simulates rather than assuming. That is
 * the same discipline as everywhere else: an unresolved fact is not a denial.
 */
export interface IntentEvidence {
  /**
   * The `bytes32` for {@link organOf}, resolved through the contract's `pure`
   * helper. Not derivable here: the domain may not hash.
   */
  readonly organ?: Bytes32;
  /**
   * `CAST_VOTE` only — what the event projection knows about the voting's own
   * governing organ. The intent cannot carry it, because `castVote` takes no
   * organ and the form must not ask for one.
   */
  readonly governingOrgan?: GoverningOrgan;
}

export function authorizationFor(
  intent: GovernanceIntent,
  evidence: IntentEvidence = {},
): AuthorizationRule {
  switch (intent.type) {
    // Member of the named organ, **or** the Chairman (`Zarya.sol:75`, `98`).
    case 'CREATE_MEMBERSHIP_VOTING':
    case 'CREATE_MEMBERSHIP_REVOCATION_VOTING':
      return evidence.organ === undefined
        ? UNDETERMINED_ORGAN
        : { kind: 'MEMBER_OR_CHAIRMAN', organ: evidence.organ };

    // Member of the named organ, and the Chairman is **not** exempt
    // (`Zarya.sol:123`, `151`, `227`, `254`). The four matrix-configuration
    // votings are the only place in the contract where the override does not
    // apply, and routing one of them to MEMBER_OR_CHAIRMAN would let a Chairman
    // sign a transaction that reverts.
    case 'CREATE_CATEGORY_VOTING':
    case 'CREATE_DECIMALS_VOTING':
    case 'CREATE_CATEGORICAL_VALUE_VOTING':
    case 'CREATE_NUMERICAL_VALUE_VOTING':
      return evidence.organ === undefined
        ? UNDETERMINED_ORGAN
        : { kind: 'MEMBER_ONLY', organ: evidence.organ };

    // No modifier and no organ argument (`Zarya.sol:170`, `193`). Open to
    // anyone, and adding a membership check would refuse calls the chain
    // accepts.
    case 'CREATE_THEME_VOTING':
    case 'CREATE_STATEMENT_VOTING':
      return PERMISSIONLESS;

    // The organ comes from the voting, not from the intent. `UNKNOWN` when the
    // projection has no entry — never `NONE`, which would mean "anyone may vote".
    case 'CAST_VOTE':
      return castVoteRule(evidence.governingOrgan ?? { kind: 'UNKNOWN' });

    // Chairman only, and the organ in the intent is the one being *configured*,
    // not the one that authorizes. Passing it to a membership rule would let any
    // member of the target organ appear entitled to set its own thresholds.
    case 'CONFIGURE_ORGAN_THRESHOLDS':
    case 'TRANSFER_CHAIRMANSHIP':
      return CHAIRMAN_ONLY;
  }
}

/**
 * The organ that must be resolved before {@link authorizationFor} can answer.
 *
 * `undefined` for the seven intents that need none — including the two
 * Chairman-only ones, whose triple is a target rather than an authorizer, and
 * `CAST_VOTE`, which needs a projection lookup instead of a resolution.
 */
export function organToResolve(intent: GovernanceIntent): PartyOrganTriple | undefined {
  switch (intent.type) {
    case 'CONFIGURE_ORGAN_THRESHOLDS':
      // Named by the intent, but not what authorizes it. It still has to be
      // resolved — the call takes the bytes32 — just not for this question.
      return undefined;
    default:
      return organOf(intent);
  }
}
