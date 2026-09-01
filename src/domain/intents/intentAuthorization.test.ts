import { describe, expect, it } from 'vitest';
import { partyOrganTriple } from '../organs/partyOrgan';
import { judgeAuthorization } from '../preflight/authorization';
import { bytes32, evmAddress } from '../primitives';
import { votingId } from '../voting/voting';
import { OPERATION_TYPES, type GovernanceIntent, votingRef } from './intent';
import { authorizationFor, organToResolve } from './intentAuthorization';

const ORGAN = bytes32('0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5');
const SOVIET = partyOrganTriple({ organType: 'RegionalSoviet', region: 20 });
const SOMEONE = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');

/** One intent per operation type, so the mapping can be swept. */
const SAMPLES: Record<string, GovernanceIntent> = {
  CREATE_MEMBERSHIP_VOTING: {
    type: 'CREATE_MEMBERSHIP_VOTING',
    organ: SOVIET,
    member: SOMEONE,
    duration: 1,
  },
  CREATE_MEMBERSHIP_REVOCATION_VOTING: {
    type: 'CREATE_MEMBERSHIP_REVOCATION_VOTING',
    organ: SOVIET,
    member: SOMEONE,
    duration: 1,
  },
  CREATE_CATEGORY_VOTING: {
    type: 'CREATE_CATEGORY_VOTING',
    organ: SOVIET,
    at: { x: 1n, y: 2n },
    category: 3n,
    categoryName: 'Good',
    duration: 1,
  },
  CREATE_DECIMALS_VOTING: {
    type: 'CREATE_DECIMALS_VOTING',
    organ: SOVIET,
    at: { x: 1n, y: 2n },
    decimals: 2,
    duration: 1,
  },
  CREATE_THEME_VOTING: {
    type: 'CREATE_THEME_VOTING',
    matrix: 'CATEGORICAL',
    x: 1n,
    theme: 'Housing',
    duration: 1,
  },
  CREATE_STATEMENT_VOTING: {
    type: 'CREATE_STATEMENT_VOTING',
    matrix: 'NUMERICAL',
    at: { x: 1n, y: 2n },
    statement: 'Rents rise',
    duration: 1,
  },
  CREATE_CATEGORICAL_VALUE_VOTING: {
    type: 'CREATE_CATEGORICAL_VALUE_VOTING',
    organ: SOVIET,
    at: { x: 1n, y: 2n },
    category: 3n,
    valueAuthor: SOMEONE,
    duration: 1,
  },
  CREATE_NUMERICAL_VALUE_VOTING: {
    type: 'CREATE_NUMERICAL_VALUE_VOTING',
    organ: SOVIET,
    at: { x: 1n, y: 2n },
    value: 1n,
    decimals: 0,
    valueAuthor: SOMEONE,
    duration: 1,
  },
  CAST_VOTE: { type: 'CAST_VOTE', voting: votingRef(votingId(7n)), direction: 'FOR' },
  CONFIGURE_ORGAN_THRESHOLDS: {
    type: 'CONFIGURE_ORGAN_THRESHOLDS',
    organ: SOVIET,
    quorum: 1n,
    approvalPercentage: 5000n,
    approvalPercentageBase: 10_000n,
  },
  TRANSFER_CHAIRMANSHIP: { type: 'TRANSFER_CHAIRMANSHIP', newChairman: SOMEONE },
};

describe('the mapping is total', () => {
  it('assigns a rule to every operation type', () => {
    for (const type of OPERATION_TYPES) {
      expect(authorizationFor(SAMPLES[type], { organ: ORGAN }).kind).toBeTypeOf('string');
    }
  });
});

describe('membership proposals', () => {
  it('allow the Chairman as well as a member', () => {
    for (const type of ['CREATE_MEMBERSHIP_VOTING', 'CREATE_MEMBERSHIP_REVOCATION_VOTING'] as const) {
      expect(authorizationFor(SAMPLES[type], { organ: ORGAN })).toEqual({
        kind: 'MEMBER_OR_CHAIRMAN',
        organ: ORGAN,
      });
    }
  });
});

describe('the four matrix-configuration proposals', () => {
  const FOUR = [
    'CREATE_CATEGORY_VOTING',
    'CREATE_DECIMALS_VOTING',
    'CREATE_CATEGORICAL_VALUE_VOTING',
    'CREATE_NUMERICAL_VALUE_VOTING',
  ] as const;

  it('require actual membership, with no Chairman exemption', () => {
    for (const type of FOUR) {
      expect(authorizationFor(SAMPLES[type], { organ: ORGAN })).toEqual({
        kind: 'MEMBER_ONLY',
        organ: ORGAN,
      });
    }
  });

  it('deny a Chairman who is not a member', () => {
    // Routing one of these to MEMBER_OR_CHAIRMAN would let a Chairman sign a
    // transaction that reverts. This is the only place the override does not
    // apply, and it covers half the creation surface.
    for (const type of FOUR) {
      const rule = authorizationFor(SAMPLES[type], { organ: ORGAN });
      expect(judgeAuthorization(rule, { memberOfOrgan: false, chairman: true }).kind).toBe('DENIED');
    }
  });
});

describe('theme and statement proposals', () => {
  it('are permissionless and need no organ resolved', () => {
    for (const type of ['CREATE_THEME_VOTING', 'CREATE_STATEMENT_VOTING'] as const) {
      expect(authorizationFor(SAMPLES[type])).toEqual({ kind: 'PERMISSIONLESS' });
      expect(organToResolve(SAMPLES[type])).toBeUndefined();
    }
  });
});

describe('casting a vote', () => {
  it('takes its rule from the voting, not from the intent', () => {
    expect(authorizationFor(SAMPLES.CAST_VOTE, { governingOrgan: { kind: 'ORGAN', organ: ORGAN } })).toEqual(
      { kind: 'MEMBER_OR_CHAIRMAN', organ: ORGAN },
    );
    expect(authorizationFor(SAMPLES.CAST_VOTE, { governingOrgan: { kind: 'NONE' } })).toEqual({
      kind: 'PERMISSIONLESS',
    });
  });

  it('is undetermined when the projection knows nothing, never permissionless', () => {
    // The default with no evidence at all is the safe one: telling a non-member
    // they may vote on the strength of a gap invites a transaction that reverts.
    expect(authorizationFor(SAMPLES.CAST_VOTE)).toEqual({ kind: 'UNDETERMINED_ORGAN' });
    expect(authorizationFor(SAMPLES.CAST_VOTE, { organ: ORGAN })).toEqual({
      kind: 'UNDETERMINED_ORGAN',
    });
  });
});

describe('privileged configuration', () => {
  it('is Chairman-only, and the organ in the intent is the target rather than the authorizer', () => {
    // The trap: a threshold intent names an organ, and passing that organ to a
    // membership rule would make every member of it look entitled to set its
    // own thresholds.
    expect(authorizationFor(SAMPLES.CONFIGURE_ORGAN_THRESHOLDS, { organ: ORGAN })).toEqual({
      kind: 'CHAIRMAN_ONLY',
    });
    expect(organToResolve(SAMPLES.CONFIGURE_ORGAN_THRESHOLDS)).toBeUndefined();

    expect(authorizationFor(SAMPLES.TRANSFER_CHAIRMANSHIP)).toEqual({ kind: 'CHAIRMAN_ONLY' });
  });

  it('denies a member of the target organ who is not the Chairman', () => {
    const rule = authorizationFor(SAMPLES.CONFIGURE_ORGAN_THRESHOLDS, { organ: ORGAN });
    expect(judgeAuthorization(rule, { memberOfOrgan: true, chairman: false })).toMatchObject({
      kind: 'DENIED',
      reason: 'NOT_CHAIRMAN',
    });
  });
});

describe('an unresolved organ', () => {
  it('is undetermined rather than denied, for every intent that names one', () => {
    // An unresolved fact is not a denial — the same rule the membership reads
    // follow.
    for (const type of [
      'CREATE_MEMBERSHIP_VOTING',
      'CREATE_CATEGORY_VOTING',
      'CREATE_NUMERICAL_VALUE_VOTING',
    ] as const) {
      expect(authorizationFor(SAMPLES[type])).toEqual({ kind: 'UNDETERMINED_ORGAN' });
    }
  });

  it('names what has to be resolved before an answer is possible', () => {
    expect(organToResolve(SAMPLES.CREATE_MEMBERSHIP_VOTING)).toEqual(SOVIET);
    expect(organToResolve(SAMPLES.CAST_VOTE)).toBeUndefined();
  });
});
