import { describe, expect, it } from 'vitest';
import { evmAddress, unixSeconds } from '../primitives';
import { NO_ORGAN, type VotingRecord, votingId } from './voting';
import {
  type VotingObservations,
  classifyVotingPhase,
  executionReadiness,
  hasOpened,
  isExecutionDue,
  secondsUntilDeadline,
} from './votingLifecycle';

const DEADLINE = 1_800_000_000;

const record = (endTime = DEADLINE, startTime = DEADLINE - 3600): VotingRecord => ({
  votingId: votingId(1n),
  author: evmAddress('0x1111111111111111111111111111111111111111'),
  startTime: unixSeconds(startTime),
  endTime: unixSeconds(endTime),
  suggestionType: 'Theme',
  governingOrgan: NO_ORGAN,
  blockNumber: 100n,
});

describe('classifying the (active, finalized) pair', () => {
  const cases: ReadonlyArray<[VotingObservations, string]> = [
    [{ active: true, finalized: false }, 'ACTIVE'],
    [{ active: false, finalized: false }, 'AWAITING_EXECUTION'],
    [{ active: false, finalized: true }, 'FINALIZED'],
    // Not producible: finalization requires the window closed, since
    // executeVoting reverts VotingStillActive while isActive holds.
    [{ active: true, finalized: true }, 'UNKNOWN'],
  ];

  it.each(cases)('reads %j as %s', (observations, expected) => {
    expect(classifyVotingPhase(observations)).toBe(expected);
  });

  it('treats either flag missing as UNKNOWN, never as a state', () => {
    // The network guard's rule, applied here: an unobserved fact is not a
    // failed one. Defaulting a missing `finalized` to false would queue an
    // execution against a settled voting.
    expect(classifyVotingPhase({ active: true })).toBe('UNKNOWN');
    expect(classifyVotingPhase({ finalized: true })).toBe('UNKNOWN');
    expect(classifyVotingPhase({})).toBe('UNKNOWN');
  });

  it('does not confuse a quorum-failed voting with an unfinished one', () => {
    // Both read (false, false) forever. Chain state cannot tell them apart,
    // which is precisely why the executor must remember InsufficientVotes.
    expect(classifyVotingPhase({ active: false, finalized: false })).toBe('AWAITING_EXECUTION');
  });
});

describe('the deadline is inclusive', () => {
  it('is not due at exactly endTime', () => {
    // Votings.sol:147 compares `block.timestamp <= self.endTime`, so the voting
    // is still active at endTime and executeVoting reverts VotingStillActive.
    // A `>=` here would queue a guaranteed revert once per poll.
    expect(isExecutionDue(record(), unixSeconds(DEADLINE))).toBe(false);
  });

  it('is due one second later', () => {
    expect(isExecutionDue(record(), unixSeconds(DEADLINE + 1))).toBe(true);
  });

  it('is not due before', () => {
    expect(isExecutionDue(record(), unixSeconds(DEADLINE - 1))).toBe(false);
  });

  it('counts the inclusive second in the countdown', () => {
    expect(secondsUntilDeadline(record(), unixSeconds(DEADLINE))).toBe(1);
    expect(secondsUntilDeadline(record(), unixSeconds(DEADLINE - 10))).toBe(11);
    expect(secondsUntilDeadline(record(), unixSeconds(DEADLINE + 1))).toBe(0);
  });

  it('models the two-sided window rather than assuming startTime is past', () => {
    const future = record(DEADLINE, DEADLINE - 1);
    expect(hasOpened(future, unixSeconds(DEADLINE - 2))).toBe(false);
    expect(hasOpened(future, unixSeconds(DEADLINE - 1))).toBe(true);
  });

  it('handles a zero-duration voting, which is votable only in its own second', () => {
    // `duration` is unbounded and 0 is accepted, giving endTime == startTime.
    const instant = record(DEADLINE, DEADLINE);
    expect(hasOpened(instant, unixSeconds(DEADLINE))).toBe(true);
    expect(isExecutionDue(instant, unixSeconds(DEADLINE))).toBe(false);
    expect(isExecutionDue(instant, unixSeconds(DEADLINE + 1))).toBe(true);
  });
});

describe('execution readiness', () => {
  const past = unixSeconds(DEADLINE + 60);
  const inside = unixSeconds(DEADLINE - 60);

  it('is DUE past the deadline and unfinalized', () => {
    expect(executionReadiness(record(), { active: false, finalized: false }, past)).toBe('DUE');
  });

  it('is NOT_DUE inside the window', () => {
    expect(executionReadiness(record(), { active: true, finalized: false }, inside)).toBe(
      'NOT_DUE',
    );
  });

  it('is SETTLED once finalized, without needing the clock', () => {
    expect(executionReadiness(record(), { active: false, finalized: true }, undefined)).toBe(
      'SETTLED',
    );
  });

  it('is UNKNOWN without a chain time rather than falling back to a local one', () => {
    expect(executionReadiness(record(), { active: false, finalized: false }, undefined)).toBe(
      'UNKNOWN',
    );
  });

  it('is UNKNOWN when a flag was not observed', () => {
    expect(executionReadiness(record(), { finalized: false }, past)).toBe('UNKNOWN');
  });

  it('refuses to act when the read and the projection disagree', () => {
    // The chain says the window closed; the projected endTime says it has not.
    // One of the two is stale, and neither says execution is due.
    expect(executionReadiness(record(), { active: false, finalized: false }, inside)).toBe(
      'UNKNOWN',
    );
  });
});
