import { describe, expect, it } from 'vitest';
import {
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
  judgeDuration,
} from './durationPolicy';

describe('the duration bound', () => {
  it('accepts the range and both its edges', () => {
    expect(judgeDuration(MIN_DURATION_SECONDS)).toEqual({ kind: 'READY' });
    expect(judgeDuration(MAX_DURATION_SECONDS)).toEqual({ kind: 'READY' });
    expect(judgeDuration(7 * 24 * 60 * 60)).toEqual({ kind: 'READY' });
  });

  it('refuses zero, which the contract accepts', () => {
    // endTime = block.timestamp + 0, so the window closes in the creating block.
    // This is the one place preflight is deliberately stricter than Solidity.
    expect(judgeDuration(0)).toMatchObject({ kind: 'BLOCKED', blocker: 'CLIENT_POLICY' });
  });

  it('marks its refusals as this client’s own, with no predicted revert', () => {
    const verdict = judgeDuration(1);
    expect(verdict).toMatchObject({ blocker: 'CLIENT_POLICY' });
    // Nothing downstream may report it as something the contract said.
    expect(verdict?.kind === 'BLOCKED' && verdict.predicted).toBeUndefined();
    expect(verdict?.kind === 'BLOCKED' && verdict.meaning.disposition).toBe('REJECTED');
  });

  it('refuses the deployment’s own 120-second voting', () => {
    // Voting 1 on Sepolia ran for 120 seconds and collected zero votes — the
    // failure this bound exists to prevent, already on chain.
    expect(judgeDuration(120)).toMatchObject({ blocker: 'CLIENT_POLICY' });
  });

  it('refuses beyond the ceiling and refuses what is not a whole second count', () => {
    expect(judgeDuration(MAX_DURATION_SECONDS + 1)).toMatchObject({ blocker: 'CLIENT_POLICY' });
    expect(judgeDuration(-1)).toMatchObject({ blocker: 'CLIENT_POLICY' });
    expect(judgeDuration(3600.5)).toMatchObject({ blocker: 'CLIENT_POLICY' });
    expect(judgeDuration(Number.NaN)).toMatchObject({ blocker: 'CLIENT_POLICY' });
  });

  it('explains itself in one line safe to show a user', () => {
    const verdict = judgeDuration(60);
    expect(verdict?.kind === 'BLOCKED' && verdict.meaning.summary).toContain('at least');
  });
});
