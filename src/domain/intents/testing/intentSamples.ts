import { partyOrganTriple } from '../../organs/partyOrgan';
import { evmAddress } from '../../primitives';
import { votingId } from '../../voting/voting';
import type { GovernanceIntent, OperationType } from '../intent';
import { votingRef } from '../intent';

/**
 * One valid intent per operation type, so any total mapping over the union can
 * be swept rather than spot-checked.
 *
 * Shared because three separate suites need the same eleven, and eleven literals
 * copied per suite is how one of them ends up testing a variant the others do
 * not have. The typing is what makes it useful: the record is keyed by
 * `OperationType` with each value narrowed to *that* variant, so a twelfth
 * operation type is a missing-property error here and every sweep over
 * `OPERATION_TYPES` gains a case at once.
 *
 * Distinct values throughout — the coordinates are not `(1, 1)` and the two
 * addresses differ — because an argument-order test on `(1, 1)` passes whichever
 * way round the arguments go.
 */

/** Chechnya: ordinal 20, subject code 95. Never a region where the two agree. */
export const SAMPLE_SOVIET = partyOrganTriple({ organType: 'RegionalSoviet', region: 20 });

export const SAMPLE_MEMBER = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');

/** Deliberately not {@link SAMPLE_MEMBER}: two `address` arguments can swap. */
export const SAMPLE_AUTHOR = evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25');

type IntentOfType<T extends OperationType> = Extract<GovernanceIntent, { type: T }>;

export const INTENT_SAMPLES: { readonly [T in OperationType]: IntentOfType<T> } = {
  CREATE_MEMBERSHIP_VOTING: {
    type: 'CREATE_MEMBERSHIP_VOTING',
    organ: SAMPLE_SOVIET,
    member: SAMPLE_MEMBER,
    duration: 86_400,
  },
  CREATE_MEMBERSHIP_REVOCATION_VOTING: {
    type: 'CREATE_MEMBERSHIP_REVOCATION_VOTING',
    organ: SAMPLE_SOVIET,
    member: SAMPLE_MEMBER,
    duration: 86_400,
  },
  CREATE_CATEGORY_VOTING: {
    type: 'CREATE_CATEGORY_VOTING',
    organ: SAMPLE_SOVIET,
    at: { x: 3n, y: 7n },
    category: 5n,
    categoryName: 'Good',
    duration: 86_400,
  },
  CREATE_DECIMALS_VOTING: {
    type: 'CREATE_DECIMALS_VOTING',
    organ: SAMPLE_SOVIET,
    at: { x: 3n, y: 7n },
    decimals: 2,
    duration: 86_400,
  },
  CREATE_THEME_VOTING: {
    type: 'CREATE_THEME_VOTING',
    matrix: 'CATEGORICAL',
    x: 3n,
    theme: 'Жилищный вопрос',
    duration: 86_400,
  },
  CREATE_STATEMENT_VOTING: {
    type: 'CREATE_STATEMENT_VOTING',
    matrix: 'NUMERICAL',
    at: { x: 3n, y: 7n },
    statement: 'Аренда растёт',
    duration: 86_400,
  },
  CREATE_CATEGORICAL_VALUE_VOTING: {
    type: 'CREATE_CATEGORICAL_VALUE_VOTING',
    organ: SAMPLE_SOVIET,
    at: { x: 3n, y: 7n },
    category: 5n,
    valueAuthor: SAMPLE_AUTHOR,
    duration: 86_400,
  },
  CREATE_NUMERICAL_VALUE_VOTING: {
    type: 'CREATE_NUMERICAL_VALUE_VOTING',
    organ: SAMPLE_SOVIET,
    at: { x: 3n, y: 7n },
    value: 1234n,
    decimals: 2,
    valueAuthor: SAMPLE_AUTHOR,
    duration: 86_400,
  },
  CAST_VOTE: { type: 'CAST_VOTE', voting: votingRef(votingId(7n)), direction: 'FOR' },
  CONFIGURE_ORGAN_THRESHOLDS: {
    type: 'CONFIGURE_ORGAN_THRESHOLDS',
    organ: SAMPLE_SOVIET,
    quorum: 3n,
    approvalPercentage: 6600n,
    approvalPercentageBase: 10_000n,
  },
  TRANSFER_CHAIRMANSHIP: { type: 'TRANSFER_CHAIRMANSHIP', newChairman: SAMPLE_MEMBER },
};
