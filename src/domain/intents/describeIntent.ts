import { subjectCodeOf } from '../organs/regions';
import { scopeOf } from '../organs/partyOrgan';
import type { GovernanceIntent } from './intent';

/**
 * An intent flattened to ordered label/value pairs of strings.
 *
 * **Serialisation, not presentation.** What it knows is which fields each
 * variant has, which is the union's own business; what it deliberately does not
 * know is any Russian, any layout, or any screen. The labels are the domain's
 * field names, and translating them is the caller's job.
 *
 * Two reasons it exists rather than a caller reaching into the union:
 *
 * - **A `bigint` does not cross a process boundary reliably.** Coordinates,
 *   category ids and scaled values are all `bigint`, and a structured clone that
 *   drops or coerces one would silently address a different cell. Rendering them
 *   here, once, with `toString()`, means no boundary has to remember.
 * - **A region travels as its subject code.** `region` is an enum ordinal and
 *   they differ for 50 of 98 regions, so anything showing a member the ordinal
 *   would be showing them a *different real region*. That conversion belongs
 *   with the union rather than at whichever screen happens to render it.
 *
 * Exhaustive with a `never` check, so a twelfth variant fails to compile here
 * rather than being displayed as an empty list.
 */

export interface IntentField {
  /** The domain key, unlocalised. */
  readonly label: string;
  readonly value: string;
}

export function describeIntent(intent: GovernanceIntent): readonly IntentField[] {
  const fields: IntentField[] = [];
  const add = (label: string, value: string | bigint | number): void => {
    fields.push({ label, value: String(value) });
  };

  switch (intent.type) {
    case 'CREATE_MEMBERSHIP_VOTING':
    case 'CREATE_MEMBERSHIP_REVOCATION_VOTING':
      add('member', intent.member);
      break;

    case 'CREATE_CATEGORY_VOTING':
      addCoordinate(add, intent.at);
      add('category', intent.category);
      add('categoryName', intent.categoryName);
      break;

    case 'CREATE_DECIMALS_VOTING':
      addCoordinate(add, intent.at);
      add('decimals', intent.decimals);
      break;

    case 'CREATE_THEME_VOTING':
      add('matrix', intent.matrix);
      add('x', intent.x);
      add('theme', intent.theme);
      break;

    case 'CREATE_STATEMENT_VOTING':
      add('matrix', intent.matrix);
      addCoordinate(add, intent.at);
      add('statement', intent.statement);
      break;

    case 'CREATE_CATEGORICAL_VALUE_VOTING':
      addCoordinate(add, intent.at);
      add('category', intent.category);
      add('valueAuthor', intent.valueAuthor);
      break;

    case 'CREATE_NUMERICAL_VALUE_VOTING':
      addCoordinate(add, intent.at);
      // Both, and never the scaled integer alone: `1234` means nothing without
      // the scale that produced it, and the scale is not on the transaction.
      add('value', intent.value);
      add('decimals', intent.decimals);
      add('valueAuthor', intent.valueAuthor);
      break;

    case 'CAST_VOTE':
      add('votingId', intent.voting.votingId);
      // The direction as the form's own export value, never a rendered label:
      // `FOR`/`AGAINST` is what the option group carries and what `supportOf`
      // turns into the boolean argument.
      add('direction', intent.direction);
      break;

    case 'TRANSFER_CHAIRMANSHIP':
      add('newChairman', intent.newChairman);
      break;

    case 'CONFIGURE_ORGAN_THRESHOLDS':
      // Basis points, and said so: `5000` is 50%, and a label that let anyone
      // read it as 5000% is the mistake this vocabulary exists to prevent.
      add('quorumBasisPoints', intent.quorum);
      add('approvalPercentageBasisPoints', intent.approvalPercentage);
      add('approvalPercentageBaseBasisPoints', intent.approvalPercentageBase);
      break;

    default: {
      const unhandled: never = intent;
      void unhandled;
      break;
    }
  }

  if ('organ' in intent) {
    const { organ } = intent;
    add('organType', organ.organType);
    const scope = scopeOf(organ.organType);
    // Only the parts this organ's scope actually uses, matching what issuance
    // records: a normalized zero for the others reads as a real region 0.
    if (scope !== 'GLOBAL') add('regionSubjectCode', subjectCodeOf(organ.region));
    if (scope === 'LOCAL') add('organNumber', organ.number);
  }
  if ('duration' in intent) add('durationSeconds', intent.duration);

  return fields;
}

const addCoordinate = (
  add: (label: string, value: string | bigint | number) => void,
  at: { readonly x: bigint; readonly y: bigint },
): void => {
  add('x', at.x);
  add('y', at.y);
};
