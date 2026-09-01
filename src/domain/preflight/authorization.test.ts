import { describe, expect, it } from 'vitest';
import { bytes32 } from '../primitives';
import { SUGGESTION_TYPES } from '../voting/voting';
import {
  CHAIRMAN_ONLY,
  PERMISSIONLESS,
  UNDETERMINED_ORGAN,
  castVoteRule,
  creationRule,
  judgeAuthorization,
  needsChairmanRead,
  organToCheck,
} from './authorization';

const ORGAN = bytes32('0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5');

const MEMBER_OR_CHAIRMAN = { kind: 'MEMBER_OR_CHAIRMAN', organ: ORGAN } as const;
const MEMBER_ONLY = { kind: 'MEMBER_ONLY', organ: ORGAN } as const;

describe('permissionless calls', () => {
  it('are allowed with nothing read at all', () => {
    // `zarya-chain`: do not add a membership check to these. A client that
    // refused a non-member would refuse a call the chain accepts.
    expect(judgeAuthorization(PERMISSIONLESS, {})).toEqual({ kind: 'ALLOWED' });
    expect(judgeAuthorization(PERMISSIONLESS, { memberOfOrgan: false, chairman: false })).toEqual({
      kind: 'ALLOWED',
    });
  });
});

describe('member-or-Chairman', () => {
  it('is satisfied by either half', () => {
    expect(judgeAuthorization(MEMBER_OR_CHAIRMAN, { memberOfOrgan: true, chairman: false })).toEqual(
      { kind: 'ALLOWED' },
    );
    expect(judgeAuthorization(MEMBER_OR_CHAIRMAN, { memberOfOrgan: false, chairman: true })).toEqual(
      { kind: 'ALLOWED' },
    );
  });

  it('grants on one read even when the other never answered', () => {
    // The unread half cannot change an answer already granted, so waiting for it
    // would be a round trip spent to learn nothing.
    expect(judgeAuthorization(MEMBER_OR_CHAIRMAN, { memberOfOrgan: true })).toEqual({
      kind: 'ALLOWED',
    });
    expect(judgeAuthorization(MEMBER_OR_CHAIRMAN, { chairman: true })).toEqual({ kind: 'ALLOWED' });
  });

  it('denies only when both reads answered and both said no', () => {
    expect(
      judgeAuthorization(MEMBER_OR_CHAIRMAN, { memberOfOrgan: false, chairman: false }),
    ).toEqual({ kind: 'DENIED', reason: 'NOT_A_MEMBER', predicted: 'NotActiveMember' });
  });

  it('is undetermined when a read that could still grant is missing', () => {
    // The failure this prevents: an RPC hiccup on the Chairperson read reporting
    // the Chairman as ineligible.
    expect(judgeAuthorization(MEMBER_OR_CHAIRMAN, { memberOfOrgan: false })).toEqual({
      kind: 'UNDETERMINED',
      reason: 'MEMBERSHIP_UNREAD',
    });
    expect(judgeAuthorization(MEMBER_OR_CHAIRMAN, { chairman: false })).toEqual({
      kind: 'UNDETERMINED',
      reason: 'MEMBERSHIP_UNREAD',
    });
    expect(judgeAuthorization(MEMBER_OR_CHAIRMAN, {})).toEqual({
      kind: 'UNDETERMINED',
      reason: 'MEMBERSHIP_UNREAD',
    });
  });
});

describe('member-only, where the Chairman is not exempt', () => {
  it('ignores the Chairman entirely', () => {
    // The one place in the contract the override does not apply. A Chairman who
    // is not a member of the organ is denied.
    expect(judgeAuthorization(MEMBER_ONLY, { memberOfOrgan: false, chairman: true })).toEqual({
      kind: 'DENIED',
      reason: 'MEMBER_ONLY_ORGAN',
      predicted: 'NotActiveMember',
    });
    expect(judgeAuthorization(MEMBER_ONLY, { memberOfOrgan: true, chairman: false })).toEqual({
      kind: 'ALLOWED',
    });
  });

  it('does not ask for the Chairman read it would not use', () => {
    expect(needsChairmanRead(MEMBER_ONLY)).toBe(false);
    expect(needsChairmanRead(MEMBER_OR_CHAIRMAN)).toBe(true);
    expect(needsChairmanRead(CHAIRMAN_ONLY)).toBe(true);
    expect(needsChairmanRead(PERMISSIONLESS)).toBe(false);
  });

  it('is undetermined on an unread membership', () => {
    expect(judgeAuthorization(MEMBER_ONLY, { chairman: true })).toEqual({
      kind: 'UNDETERMINED',
      reason: 'MEMBERSHIP_UNREAD',
    });
  });
});

describe('Chairman-only', () => {
  it('turns on the Chairperson organ read alone', () => {
    expect(judgeAuthorization(CHAIRMAN_ONLY, { chairman: true })).toEqual({ kind: 'ALLOWED' });
    expect(judgeAuthorization(CHAIRMAN_ONLY, { chairman: false })).toEqual({
      kind: 'DENIED',
      reason: 'NOT_CHAIRMAN',
      predicted: 'NotChairman',
    });
    expect(judgeAuthorization(CHAIRMAN_ONLY, { memberOfOrgan: true })).toEqual({
      kind: 'UNDETERMINED',
      reason: 'MEMBERSHIP_UNREAD',
    });
  });

  it('names no organ to read', () => {
    expect(organToCheck(CHAIRMAN_ONLY)).toBeUndefined();
    expect(organToCheck(PERMISSIONLESS)).toBeUndefined();
    expect(organToCheck(MEMBER_ONLY)).toBe(ORGAN);
    expect(organToCheck(MEMBER_OR_CHAIRMAN)).toBe(ORGAN);
  });
});

describe('the undetermined organ', () => {
  it('never resolves, whatever was read', () => {
    // A voting missing from the projection has an eligibility nobody can
    // evaluate locally. Reads about other organs do not substitute for it.
    expect(judgeAuthorization(UNDETERMINED_ORGAN, { memberOfOrgan: true, chairman: true })).toEqual(
      { kind: 'UNDETERMINED', reason: 'ORGAN_UNKNOWN' },
    );
  });
});

describe('the rule guarding castVote', () => {
  it('reads a voting with no organ as open to anyone', () => {
    // Theme and statement votings skip the organ check entirely, so this is a
    // permission and not an absence.
    expect(castVoteRule({ kind: 'NONE' })).toEqual(PERMISSIONLESS);
  });

  it('never lets an unknown organ borrow that permission', () => {
    // Collapsing UNKNOWN into NONE would tell a non-member they may vote, and
    // they would sign a transaction that reverts.
    expect(castVoteRule({ kind: 'UNKNOWN' })).toEqual(UNDETERMINED_ORGAN);
    expect(castVoteRule({ kind: 'UNKNOWN' })).not.toEqual(PERMISSIONLESS);
  });

  it('grants the Chairman the exemption castVote actually has', () => {
    expect(castVoteRule({ kind: 'ORGAN', organ: ORGAN })).toEqual(MEMBER_OR_CHAIRMAN);
  });
});

describe('the rules guarding creation', () => {
  it('matches the access-control table for every suggestion type', () => {
    expect(creationRule('Membership', ORGAN)).toEqual(MEMBER_OR_CHAIRMAN);
    expect(creationRule('MembershipRevocation', ORGAN)).toEqual(MEMBER_OR_CHAIRMAN);

    // The four the Chairman is not exempt from.
    expect(creationRule('Category', ORGAN)).toEqual(MEMBER_ONLY);
    expect(creationRule('Decimals', ORGAN)).toEqual(MEMBER_ONLY);
    expect(creationRule('CategoricalValue', ORGAN)).toEqual(MEMBER_ONLY);
    expect(creationRule('NumericalValue', ORGAN)).toEqual(MEMBER_ONLY);

    // Open to anyone: no modifier and no organ argument at all.
    expect(creationRule('Theme', ORGAN)).toEqual(PERMISSIONLESS);
    expect(creationRule('Statement', ORGAN)).toEqual(PERMISSIONLESS);
  });

  it('covers all eight types, so a ninth cannot inherit a rule silently', () => {
    for (const type of SUGGESTION_TYPES) {
      expect(creationRule(type, ORGAN).kind).toBeTypeOf('string');
    }
    expect(SUGGESTION_TYPES).toHaveLength(8);
  });

  it('never grants the Chairman a matrix-configuration voting', () => {
    // The single most tempting wrong generalization: "the Chairman can do
    // anything". Four of the eight say otherwise.
    const asChairman = { memberOfOrgan: false, chairman: true };
    for (const type of ['Category', 'Decimals', 'CategoricalValue', 'NumericalValue'] as const) {
      expect(judgeAuthorization(creationRule(type, ORGAN), asChairman).kind).toBe('DENIED');
    }
    for (const type of ['Membership', 'MembershipRevocation'] as const) {
      expect(judgeAuthorization(creationRule(type, ORGAN), asChairman).kind).toBe('ALLOWED');
    }
  });
});
