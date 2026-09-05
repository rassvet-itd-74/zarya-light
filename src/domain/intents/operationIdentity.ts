import { type PartyOrganTriple, scopeOf } from '../organs/partyOrgan';
import { subjectCodeOf } from '../organs/regions';
import type { ChainId, EvmAddress } from '../primitives';
import type { GovernanceIntent, VoteDirection } from './intent';

/**
 * What makes two imported forms **the same operation**, independent of file
 * bytes.
 *
 * Dedup by `operationRef` catches the same *file* twice. This catches the case
 * that costs something: two forms, issued separately, asking the chain for the
 * same thing. A member who reissued a template because they mislaid the first
 * has two valid references and one intention, and submitting both creates two
 * votings.
 *
 * ## The signer is absent, deliberately
 *
 * `zarya-intents` specifies chain, contract, **signer**, operation type and
 * normalized arguments. There is no `Signer` port until Phase 6 — and when it
 * arrives it adds nothing here. Hard rule 8 is one wallet per installation, so
 * within a single database the signer is a constant, and a constant
 * distinguishes nothing. It belongs in the key when the client can hold two
 * wallets, not before; a column repeating one value looks considered and is not.
 *
 * ## A vote's direction is excluded on purpose
 *
 * A vote's identity is `chain + contract + votingId`, so `FOR` and `AGAINST`
 * **collide**. Two forms voting opposite ways on one voting are not two
 * operations, they are a contradiction — and the rule is to surface a conflict
 * rather than pick one. Folding direction into the key would make them unrelated
 * and both would submit. {@link voteDirectionOf} carries it separately so a
 * caller can tell "the same vote again" from "the opposite vote".
 *
 * ## A string, not a hash
 *
 * The domain may not import `node:crypto` (hard rule 9), and it does not need
 * to: what a key has to be is *stable and distinct*, which a canonical string
 * already is. It is also readable in a database, where a digest would have to be
 * recomputed to mean anything.
 *
 * Components are length-prefixed rather than delimiter-joined, because
 * `["ab","c"]` and `["a","bc"]` must not collide and any separator chosen to be
 * improbable is a bug waiting for a governance statement that contains it.
 */

const encode = (components: readonly string[]): string =>
  components.map((component) => `${component.length}:${component}`).join('');

export interface IdentityScope {
  readonly chainId: ChainId;
  readonly contractAddress: EvmAddress;
}

/**
 * The canonical identity of an intent on a deployment.
 *
 * Normalization happens here rather than in callers: addresses lower-cased, a
 * region as its subject code, and a numerical value carrying its scale — `1234`
 * at two decimals and `12340` at three are the same quantity, so both parts are
 * in the key and neither alone would do.
 */
export function canonicalIdentity(intent: GovernanceIntent, scope: IdentityScope): string {
  return encode([
    String(scope.chainId),
    scope.contractAddress.toLowerCase(),
    intent.type,
    ...argumentsOf(intent),
  ]);
}

/** The direction a vote asks for; `undefined` for every other operation. */
export function voteDirectionOf(intent: GovernanceIntent): VoteDirection | undefined {
  return intent.type === 'CAST_VOTE' ? intent.direction : undefined;
}

function argumentsOf(intent: GovernanceIntent): readonly string[] {
  switch (intent.type) {
    case 'CREATE_MEMBERSHIP_VOTING':
    case 'CREATE_MEMBERSHIP_REVOCATION_VOTING':
      return [...organParts(intent.organ), intent.member.toLowerCase()];

    case 'CREATE_CATEGORY_VOTING':
      return [
        ...organParts(intent.organ),
        String(intent.at.x),
        String(intent.at.y),
        String(intent.category),
        intent.categoryName,
      ];

    case 'CREATE_DECIMALS_VOTING':
      return [
        ...organParts(intent.organ),
        String(intent.at.x),
        String(intent.at.y),
        String(intent.decimals),
      ];

    case 'CREATE_THEME_VOTING':
      return [intent.matrix, String(intent.x), intent.theme];

    case 'CREATE_STATEMENT_VOTING':
      // Both coordinates: `x` gates the write and `y` addresses it, so two
      // statements differing only in `x` are different proposals.
      return [intent.matrix, String(intent.at.x), String(intent.at.y), intent.statement];

    case 'CREATE_CATEGORICAL_VALUE_VOTING':
      return [
        ...organParts(intent.organ),
        String(intent.at.x),
        String(intent.at.y),
        String(intent.category),
        intent.valueAuthor.toLowerCase(),
      ];

    case 'CREATE_NUMERICAL_VALUE_VOTING':
      return [
        ...organParts(intent.organ),
        String(intent.at.x),
        String(intent.at.y),
        String(intent.value),
        String(intent.decimals),
        intent.valueAuthor.toLowerCase(),
      ];

    case 'CAST_VOTE':
      // No direction. See the note above.
      return [String(intent.voting.votingId)];

    case 'TRANSFER_CHAIRMANSHIP':
      return [intent.newChairman.toLowerCase()];

    case 'CONFIGURE_ORGAN_THRESHOLDS':
      // All three, never collapsed: the base doubles as an enable flag, so two
      // configurations differing only in it have different outcomes.
      return [
        ...organParts(intent.organ),
        String(intent.quorum),
        String(intent.approvalPercentage),
        String(intent.approvalPercentageBase),
      ];

    default: {
      const unhandled: never = intent;
      void unhandled;
      // A throw rather than a fallback: an identity derived for an operation
      // this function does not know would dedup against the wrong thing.
      throw new Error('cannot derive an identity for this intent');
    }
  }
}

/**
 * The organ as a document renders it — subject code, never the ordinal.
 *
 * Only the parts the scope uses, matching what issuance records. An empty
 * component is still a component, so a global organ cannot collide with a
 * regional one that happens to share a prefix.
 */
function organParts(organ: PartyOrganTriple): readonly string[] {
  const scope = scopeOf(organ.organType);
  return [
    organ.organType,
    scope === 'GLOBAL' ? '' : subjectCodeOf(organ.region),
    scope === 'LOCAL' ? String(organ.number) : '',
  ];
}
