import { formatFixedPoint } from '../matrix/fixedPoint';
import { partyOrganIdentifier } from '../organs/partyOrgan';
import type { GovernanceIntent, IntentContext } from './intent';
import { organOf, supportOf } from './intent';

/**
 * What makes two imports the same operation, and what makes them a conflict.
 *
 * **Independent of file bytes.** A content hash catches the same file imported
 * twice; it says nothing about the same vote arriving as a rescan, a re-export,
 * or a second copy someone printed. Identity is derived from what the operation
 * *is*, so those all collapse to one — and `hasVoted` is still the final
 * protection, because two clients can race a duplicate the database never saw.
 *
 * The key includes chain and contract, so the same proposal against a different
 * deployment is a different operation and never dedups against this one. It
 * includes the signer, because two members casting the same vote are two
 * operations, not a duplicate.
 *
 * ## Direction is deliberately not in the vote key
 *
 * `zarya-intents`: if the same signer imports both `FOR` and `AGAINST` for one
 * voting, surface a conflict — never pick one. That only works if both map to
 * the **same** key and differ in a field beside it, so the vote key stops at the
 * voting and `conflictsWith` compares the direction. Putting direction in the key
 * would make the two look like unrelated operations and both would be submitted;
 * the second would revert `AlreadyVoted`, which reads as idempotent completion —
 * so a contradiction would be silently reported as success.
 */

/**
 * A stable string key. Not a hash: it is read in logs, in a database index, and
 * in an audit trail, and a hash there would need a lookup table to be useful.
 *
 * Segments are joined with a separator that cannot occur inside one — every
 * component below is hex, decimal, an enum name, or a length-prefixed string.
 */
export type OperationKey = string;

const SEPARATOR = '|';

/**
 * Length-prefixes free text so it cannot forge a segment boundary.
 *
 * Without this, a theme of `a|b` and a theme of `a` followed by a component `b`
 * produce the same key — which is a collision an author controls, and therefore
 * a way to make one proposal dedup against another.
 */
const bounded = (text: string): string => `${text.length}:${text}`;

/**
 * The key an operation dedups on.
 *
 * Exhaustive over the union with no default arm, so a new variant must state its
 * own identity rather than inheriting one that silently collides.
 */
export function operationKey(intent: GovernanceIntent, context: IntentContext): OperationKey {
  const prefix = [
    context.chainId.toString(),
    context.contractAddress.toLowerCase(),
    context.signer.toLowerCase(),
    intent.type,
  ];

  const organ = organOf(intent);
  const withOrgan = organ === undefined ? prefix : [...prefix, bounded(partyOrganIdentifier(organ))];

  switch (intent.type) {
    case 'CREATE_MEMBERSHIP_VOTING':
    case 'CREATE_MEMBERSHIP_REVOCATION_VOTING':
      // Duration is excluded on purpose: proposing the same membership change
      // for a day or for a week is the same proposal, and a member who
      // re-exported a template with a different duration should be told it is a
      // duplicate rather than allowed to create two competing votings.
      return [...withOrgan, intent.member.toLowerCase()].join(SEPARATOR);

    case 'CREATE_CATEGORY_VOTING':
      return [
        ...withOrgan,
        intent.at.x.toString(),
        intent.at.y.toString(),
        intent.category.toString(),
        bounded(intent.categoryName),
      ].join(SEPARATOR);

    case 'CREATE_DECIMALS_VOTING':
      return [
        ...withOrgan,
        intent.at.x.toString(),
        intent.at.y.toString(),
        intent.decimals.toString(),
      ].join(SEPARATOR);

    case 'CREATE_THEME_VOTING':
      return [...withOrgan, intent.matrix, intent.x.toString(), bounded(intent.theme)].join(
        SEPARATOR,
      );

    case 'CREATE_STATEMENT_VOTING':
      return [
        ...withOrgan,
        intent.matrix,
        intent.at.x.toString(),
        intent.at.y.toString(),
        bounded(intent.statement),
      ].join(SEPARATOR);

    case 'CREATE_CATEGORICAL_VALUE_VOTING':
      return [
        ...withOrgan,
        intent.at.x.toString(),
        intent.at.y.toString(),
        intent.category.toString(),
        intent.valueAuthor.toLowerCase(),
      ].join(SEPARATOR);

    case 'CREATE_NUMERICAL_VALUE_VOTING':
      // The **scaled** integer plus its scale, not the text that produced it.
      // `1.5` and `1.50` against a two-decimal cell are one proposal, and a key
      // built from the written form would submit both.
      return [
        ...withOrgan,
        intent.at.x.toString(),
        intent.at.y.toString(),
        intent.value.toString(),
        intent.decimals.toString(),
        intent.valueAuthor.toLowerCase(),
      ].join(SEPARATOR);

    case 'CAST_VOTE':
      // Direction excluded — see the note above. This is the key a FOR and an
      // AGAINST for the same voting must share for the conflict to be visible.
      return [...withOrgan, intent.voting.votingId.toString()].join(SEPARATOR);

    case 'CONFIGURE_ORGAN_THRESHOLDS':
      // All three values, because two different configurations of one organ are
      // two operations. Collapsing them to "configure this organ" would let a
      // second import silently replace the first in a batch.
      return [
        ...withOrgan,
        intent.quorum.toString(),
        intent.approvalPercentage.toString(),
        intent.approvalPercentageBase.toString(),
      ].join(SEPARATOR);

    case 'TRANSFER_CHAIRMANSHIP':
      return [...withOrgan, intent.newChairman.toLowerCase()].join(SEPARATOR);
  }
}

/**
 * Why two operations sharing a key are not simply duplicates.
 *
 * `DUPLICATE` is the ordinary case — the same operation twice, one of which is
 * dropped. `CONTRADICTION` is the one that must reach a human.
 */
export type IdentityRelation = 'UNRELATED' | 'DUPLICATE' | 'CONTRADICTION';

/**
 * Compares two intents from the same context.
 *
 * The only contradiction the intent layer can see is a vote cast both ways by
 * one signer on one voting. Everything else that shares a key is a genuine
 * duplicate: the arguments are in the key, so differing arguments produce
 * different keys.
 */
export function relate(
  a: GovernanceIntent,
  b: GovernanceIntent,
  context: IntentContext,
): IdentityRelation {
  if (operationKey(a, context) !== operationKey(b, context)) return 'UNRELATED';
  if (a.type === 'CAST_VOTE' && b.type === 'CAST_VOTE' && a.direction !== b.direction) {
    // Never resolved by import order (`DECISIONS.md`, "Bulk behavior"). Both are
    // surfaced and neither is submitted until a person decides.
    return 'CONTRADICTION';
  }
  return 'DUPLICATE';
}

/**
 * A one-line description for an audit trail and a review screen.
 *
 * Safe to display: it contains no key material, and every value in it is one the
 * member already wrote or the app already showed them. It is a **rendering**,
 * never a source — nothing parses this back into an intent.
 */
export function describeIntent(intent: GovernanceIntent): string {
  const organ = organOf(intent);
  const on = organ === undefined ? '' : ` for ${partyOrganIdentifier(organ)}`;

  switch (intent.type) {
    case 'CREATE_MEMBERSHIP_VOTING':
      return `Propose admitting ${intent.member}${on}`;
    case 'CREATE_MEMBERSHIP_REVOCATION_VOTING':
      return `Propose removing ${intent.member}${on}`;
    case 'CREATE_CATEGORY_VOTING':
      return `Propose category ${intent.category} “${intent.categoryName}” at (${intent.at.x}, ${intent.at.y})${on}`;
    case 'CREATE_DECIMALS_VOTING':
      return `Propose ${intent.decimals} decimal place(s) at (${intent.at.x}, ${intent.at.y})${on}`;
    case 'CREATE_THEME_VOTING':
      return `Propose ${intent.matrix.toLowerCase()} theme “${intent.theme}” for column ${intent.x}`;
    case 'CREATE_STATEMENT_VOTING':
      return `Propose ${intent.matrix.toLowerCase()} statement “${intent.statement}” for row ${intent.at.y}`;
    case 'CREATE_CATEGORICAL_VALUE_VOTING':
      return `Propose category ${intent.category} at (${intent.at.x}, ${intent.at.y})${on}`;
    case 'CREATE_NUMERICAL_VALUE_VOTING':
      // Rendered back through the same scale it was parsed with, so the review
      // screen shows what the member wrote rather than the stored integer.
      return `Propose value ${formatFixedPoint(intent.value, intent.decimals)} at (${intent.at.x}, ${intent.at.y})${on}`;
    case 'CAST_VOTE':
      return `Vote ${supportOf(intent.direction) ? 'FOR' : 'AGAINST'} voting ${intent.voting.votingId}`;
    case 'CONFIGURE_ORGAN_THRESHOLDS':
      // Basis points, stated as basis points. Rendering a percentage here would
      // be the first step toward someone entering one.
      return (
        `Configure${on}: quorum ${intent.quorum}, approval ${intent.approvalPercentage} ` +
        `of base ${intent.approvalPercentageBase} (basis points)`
      );
    case 'TRANSFER_CHAIRMANSHIP':
      return `Transfer chairmanship to ${intent.newChairman}`;
  }
}
