import { describe, expect, it } from 'vitest';
import { ZARYA_ERROR_NAMES } from '../chain/contractErrors';
import {
  READY,
  blocked,
  blockedByPolicy,
  blockerFor,
  resolvePreflight,
  undetermined,
} from './verdict';

describe('a blocked verdict borrows its meaning from the error registry', () => {
  it('carries the disposition the registry already assigns', () => {
    // No second copy of the wording, and no second opinion about retryability.
    expect(blocked('ALREADY_VOTED', 'AlreadyVoted').meaning.disposition).toBe('ALREADY_DONE');
    expect(blocked('NOT_AUTHORIZED', 'NotChairman').meaning.disposition).toBe('REJECTED');
    expect(blocked('CONTRACT_REFUSED', 'InsufficientVotes').meaning.disposition).toBe('TERMINAL');
  });

  it('resolves a panic code to its specific summary', () => {
    expect(blocked('CONTRACT_REFUSED', 'Panic', 0x32n).meaning.summary).toContain('past the end');
  });
});

describe('a client-policy refusal', () => {
  it('is marked as this client’s own and carries no predicted revert', () => {
    const verdict = blockedByPolicy('Too short.');
    expect(verdict).toEqual({
      kind: 'BLOCKED',
      blocker: 'CLIENT_POLICY',
      meaning: { disposition: 'REJECTED', summary: 'Too short.' },
    });
    // Nothing downstream can mistake it for something the contract said.
    expect(verdict.kind === 'BLOCKED' && verdict.predicted).toBeUndefined();
  });
});

describe('mapping a decoded revert onto a blocker', () => {
  it('mirrors the guards preflight models and nothing else', () => {
    expect(blockerFor('NotActiveMember')).toBe('NOT_AUTHORIZED');
    expect(blockerFor('NotChairman')).toBe('NOT_AUTHORIZED');
    expect(blockerFor('VotingNotFound')).toBe('VOTING_NOT_FOUND');
    expect(blockerFor('VotingNotActive')).toBe('VOTING_WINDOW_CLOSED');
    expect(blockerFor('AlreadyVoted')).toBe('ALREADY_VOTED');
  });

  it('sends everything else to CONTRACT_REFUSED rather than the nearest arm', () => {
    expect(blockerFor('InsufficientVotes')).toBe('CONTRACT_REFUSED');
    expect(blockerFor('InvalidOrgan')).toBe('CONTRACT_REFUSED');
    expect(blockerFor('NoThemeSet')).toBe('CONTRACT_REFUSED');
    expect(blockerFor('Panic')).toBe('CONTRACT_REFUSED');
  });

  it('has an answer for every error this client can name', () => {
    for (const name of ZARYA_ERROR_NAMES) {
      expect(blockerFor(name)).toBeTypeOf('string');
    }
  });
});

describe('resolving guards written in contract order', () => {
  it('is READY when every guard passed', () => {
    expect(resolvePreflight([READY, undefined, READY])).toEqual(READY);
    expect(resolvePreflight([])).toEqual(READY);
  });

  it('returns the earliest blocker, which is the revert the chain would raise', () => {
    const verdict = resolvePreflight([
      blocked('NOT_AUTHORIZED', 'NotActiveMember'),
      blocked('VOTING_WINDOW_CLOSED', 'VotingNotActive'),
    ]);
    // Membership is checked before the window (Zarya.sol:272-278), so a
    // non-member looking at a closed voting is refused for membership.
    expect(verdict).toMatchObject({ blocker: 'NOT_AUTHORIZED', predicted: 'NotActiveMember' });
  });

  it('lets a definite blocker win over an earlier unknown, but drops the prediction', () => {
    const verdict = resolvePreflight([
      undetermined('MEMBERSHIP_UNREAD'),
      blocked('VOTING_WINDOW_CLOSED', 'VotingNotActive'),
    ]);
    // The call cannot succeed either way, so "blocked" is honest. Which error it
    // raises is not: if membership also fails, the chain reverts there first.
    expect(verdict.kind).toBe('BLOCKED');
    expect(verdict).toMatchObject({ blocker: 'VOTING_WINDOW_CLOSED' });
    expect(verdict.kind === 'BLOCKED' && verdict.predicted).toBeUndefined();
  });

  it('keeps a client-policy refusal exact despite an earlier unknown', () => {
    // It is not a contract guard, so an unresolved contract guard before it says
    // nothing about it.
    const policy = blockedByPolicy('Too short.');
    expect(resolvePreflight([undetermined('MEMBERSHIP_UNREAD'), policy])).toEqual(policy);
  });

  it('returns the first unknown when no guard definitively blocks', () => {
    expect(
      resolvePreflight([READY, undetermined('ORGAN_UNKNOWN'), undetermined('VOTING_UNREAD')]),
    ).toEqual(undetermined('ORGAN_UNKNOWN'));
  });
});
