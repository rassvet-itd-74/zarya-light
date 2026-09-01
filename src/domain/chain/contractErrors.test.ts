import { describe, expect, it } from 'vitest';
import {
  type CallOutcome,
  PANIC_SUMMARIES,
  ZARYA_ERROR_NAMES,
  type ZaryaErrorName,
  isRetryable,
  isTerminal,
  isZaryaErrorName,
  meaningOf,
} from './contractErrors';

const reverted = (name: ZaryaErrorName, panicCode?: bigint): CallOutcome => ({
  kind: 'REVERTED',
  name,
  meaning: meaningOf(name, panicCode),
});

describe('every registered error has a meaning', () => {
  it('covers the whole list with a summary and a disposition', () => {
    for (const name of ZARYA_ERROR_NAMES) {
      const meaning = meaningOf(name);
      expect(meaning.summary.length, name).toBeGreaterThan(0);
      expect(
        ['ALREADY_DONE', 'NOT_YET', 'REJECTED', 'TERMINAL'],
        name,
      ).toContain(meaning.disposition);
    }
  });

  it('names the three the ABI omits', () => {
    // Raised from external library functions, so solc never puts them in the
    // contract ABI. Registering them by hand is the only reason they decode.
    for (const name of ['NoThemeSet', 'NoStatementSet', 'InvalidCategory']) {
      expect(isZaryaErrorName(name)).toBe(true);
    }
  });

  it('does not claim an unknown name', () => {
    expect(isZaryaErrorName('SomethingElse')).toBe(false);
  });
});

describe('InsufficientVotes is terminal', () => {
  it('is never retryable and never merely rejected', () => {
    // The rule the executor is built on. `executeVoting` reverts here and
    // leaves `finalized` false, so discovery re-offers the voting forever and
    // every retry reverts identically.
    const outcome = reverted('InsufficientVotes');
    expect(outcome.kind === 'REVERTED' && outcome.meaning.disposition).toBe('TERMINAL');
    expect(isTerminal(outcome)).toBe(true);
    expect(isRetryable(outcome)).toBe(false);
  });

  it('reads as permanent to a user, not as a transient failure', () => {
    expect(meaningOf('InsufficientVotes').summary).toMatch(/never|not be retried/i);
  });
});

describe('dispositions drive retry', () => {
  it('treats a closed race as already done, not as failure', () => {
    for (const name of ['AlreadyVoted', 'VotingAlreadyFinalized'] as const) {
      expect(meaningOf(name).disposition).toBe('ALREADY_DONE');
      expect(isTerminal(reverted(name))).toBe(false);
      expect(isRetryable(reverted(name))).toBe(false);
    }
  });

  it('marks only VotingStillActive as worth sending again unchanged', () => {
    expect(isRetryable(reverted('VotingStillActive'))).toBe(true);

    const others = ZARYA_ERROR_NAMES.filter((name) => name !== 'VotingStillActive');
    for (const name of others) {
      expect(isRetryable(reverted(name)), name).toBe(false);
    }
  });

  it('treats a permanently bound cell as terminal', () => {
    expect(isTerminal(reverted('InvalidOrgan'))).toBe(true);
  });

  it('lists exactly two terminal errors', () => {
    const terminal = ZARYA_ERROR_NAMES.filter((name) => isTerminal(reverted(name)));
    expect([...terminal].sort()).toEqual(['InsufficientVotes', 'InvalidOrgan']);
  });
});

describe('an unknown outcome is never a verdict', () => {
  it('is neither terminal nor a decoded revert', () => {
    for (const reason of ['NOT_A_REVERT', 'EMPTY_REVERT', 'UNDECODABLE'] as const) {
      const outcome: CallOutcome = { kind: 'UNKNOWN', reason };
      expect(isTerminal(outcome)).toBe(false);
    }
  });

  it('retries a transport failure and only a transport failure', () => {
    // An outage is reconcile-later. An undecodable or empty revert is a real
    // answer we cannot read, and hammering it would not help.
    expect(isRetryable({ kind: 'UNKNOWN', reason: 'NOT_A_REVERT' })).toBe(true);
    expect(isRetryable({ kind: 'UNKNOWN', reason: 'EMPTY_REVERT' })).toBe(false);
    expect(isRetryable({ kind: 'UNKNOWN', reason: 'UNDECODABLE' })).toBe(false);
  });
});

describe('panic codes', () => {
  it('describes each reachable code specifically', () => {
    expect(meaningOf('Panic', 0x11n).summary).toBe(PANIC_SUMMARIES['0x11']);
    expect(meaningOf('Panic', 0x12n).summary).toBe(PANIC_SUMMARIES['0x12']);
    expect(meaningOf('Panic', 0x32n).summary).toMatch(/past the end/);
  });

  it('falls back to the generic summary for a code we have not described', () => {
    expect(meaningOf('Panic', 0x01n).summary).toBe(meaningOf('Panic').summary);
  });

  it('keeps 0x12 decodable although this source can no longer raise it', () => {
    // Guarded on 2026-08-24, but the authority is deployed bytecode, not this
    // tree — a deployment predating the fix still raises it.
    expect(PANIC_SUMMARIES['0x12']).toBeDefined();
  });
});
