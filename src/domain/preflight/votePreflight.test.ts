import { describe, expect, it } from 'vitest';
import { bytes32 } from '../primitives';
import type { GoverningOrgan } from '../voting/voting';
import { judgeVotePreflight } from './votePreflight';

const ORGAN = bytes32('0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5');
const GOVERNED: GoverningOrgan = { kind: 'ORGAN', organ: ORGAN };

const member = { memberOfOrgan: true, chairman: false };
const stranger = { memberOfOrgan: false, chairman: false };

describe('a member voting on an open voting', () => {
  it('is ready', () => {
    const { verdict, authorization } = judgeVotePreflight({
      governingOrgan: GOVERNED,
      phase: 'ACTIVE',
      hasVoted: false,
      membership: member,
    });

    expect(verdict).toEqual({ kind: 'READY' });
    expect(authorization).toEqual({ kind: 'ALLOWED' });
  });
});

describe('guard order', () => {
  it('refuses a non-member for membership, not for the closed window', () => {
    // The ordering claim this whole module exists to get right. castVote checks
    // the organ before Votings.castVote ever tests isActive, so a stranger
    // looking at an expired voting is told NotActiveMember. Reporting the
    // deadline would name a revert the chain never raises.
    const { verdict } = judgeVotePreflight({
      governingOrgan: GOVERNED,
      phase: 'AWAITING_EXECUTION',
      hasVoted: false,
      membership: stranger,
    });

    expect(verdict).toMatchObject({
      kind: 'BLOCKED',
      blocker: 'NOT_AUTHORIZED',
      predicted: 'NotActiveMember',
    });
  });

  it('refuses a member for the window once membership is settled', () => {
    const { verdict } = judgeVotePreflight({
      governingOrgan: GOVERNED,
      phase: 'AWAITING_EXECUTION',
      hasVoted: false,
      membership: member,
    });

    expect(verdict).toMatchObject({
      kind: 'BLOCKED',
      blocker: 'VOTING_WINDOW_CLOSED',
      predicted: 'VotingNotActive',
    });
  });

  it('reports a finalized voting as a closed window, because the contract does', () => {
    // Votings.castVote tests isActive and nothing else (Votings.sol:392), so a
    // finalized voting is refused for its window rather than for being finalized.
    const { verdict } = judgeVotePreflight({
      governingOrgan: GOVERNED,
      phase: 'FINALIZED',
      hasVoted: false,
      membership: member,
    });

    expect(verdict).toMatchObject({ predicted: 'VotingNotActive' });
  });
});

describe('a vote already cast', () => {
  it('is completion, not failure', () => {
    // AlreadyVoted is idempotent: a caller retrying a vote that landed should see
    // it as done rather than as an error to report.
    const { verdict } = judgeVotePreflight({
      governingOrgan: GOVERNED,
      phase: 'ACTIVE',
      hasVoted: true,
      membership: member,
    });

    expect(verdict).toMatchObject({ blocker: 'ALREADY_VOTED', predicted: 'AlreadyVoted' });
    expect(verdict.kind === 'BLOCKED' && verdict.meaning.disposition).toBe('ALREADY_DONE');
  });
});

describe('votings with no organ', () => {
  it('lets anyone vote, without a membership read', () => {
    // Theme and statement votings skip the organ check. Refusing a non-member
    // here would refuse a call the chain accepts.
    const { verdict } = judgeVotePreflight({
      governingOrgan: { kind: 'NONE' },
      phase: 'ACTIVE',
      hasVoted: false,
      membership: {},
    });

    expect(verdict).toEqual({ kind: 'READY' });
  });
});

describe('votings missing from the projection', () => {
  it('are undetermined, never open', () => {
    // The failure mode: telling a non-member they are eligible on the strength of
    // a projection gap, and watching them sign a transaction that reverts.
    const { verdict, authorization } = judgeVotePreflight({
      governingOrgan: { kind: 'UNKNOWN' },
      phase: 'ACTIVE',
      hasVoted: false,
      membership: { memberOfOrgan: false, chairman: false },
    });

    expect(verdict).toEqual({ kind: 'UNDETERMINED', reason: 'ORGAN_UNKNOWN' });
    expect(authorization).toEqual({ kind: 'UNDETERMINED', reason: 'ORGAN_UNKNOWN' });
  });

  it('still report a definite later blocker, so the gap does not hide a settled answer', () => {
    const { verdict } = judgeVotePreflight({
      governingOrgan: { kind: 'UNKNOWN' },
      phase: 'ACTIVE',
      hasVoted: true,
      membership: {},
    });

    expect(verdict).toMatchObject({ kind: 'BLOCKED', blocker: 'ALREADY_VOTED' });
    // But not which revert: if the organ check also fails, the chain reverts there.
    expect(verdict.kind === 'BLOCKED' && verdict.predicted).toBeUndefined();
  });
});

describe('unread state', () => {
  it('is undetermined rather than refused, in every direction', () => {
    expect(
      judgeVotePreflight({
        governingOrgan: GOVERNED,
        phase: 'UNKNOWN',
        hasVoted: false,
        membership: member,
      }).verdict,
    ).toEqual({ kind: 'UNDETERMINED', reason: 'VOTING_UNREAD' });

    expect(
      judgeVotePreflight({
        governingOrgan: GOVERNED,
        phase: 'ACTIVE',
        hasVoted: undefined,
        membership: member,
      }).verdict,
    ).toEqual({ kind: 'UNDETERMINED', reason: 'VOTING_UNREAD' });

    expect(
      judgeVotePreflight({
        governingOrgan: GOVERNED,
        phase: 'ACTIVE',
        hasVoted: false,
        membership: { memberOfOrgan: false },
      }).verdict,
    ).toEqual({ kind: 'UNDETERMINED', reason: 'MEMBERSHIP_UNREAD' });
  });

  it('does not let an unread membership hide the Chairman’s exemption', () => {
    const { verdict } = judgeVotePreflight({
      governingOrgan: GOVERNED,
      phase: 'ACTIVE',
      hasVoted: false,
      membership: { chairman: true },
    });

    expect(verdict).toEqual({ kind: 'READY' });
  });
});
