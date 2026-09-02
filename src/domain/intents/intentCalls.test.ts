import { describe, expect, it } from 'vitest';
import { OPERATION_TYPES } from './intent';
import {
  ZARYA_WRITE_FUNCTIONS,
  type ZaryaWriteCall,
  callsForIntent,
  organOfCall,
} from './intentCalls';
import { INTENT_SAMPLES, SAMPLE_SOVIET } from './testing/intentSamples';

const thresholds = (base: bigint): readonly ZaryaWriteCall[] =>
  callsForIntent({
    ...INTENT_SAMPLES.CONFIGURE_ORGAN_THRESHOLDS,
    approvalPercentageBase: base,
  });

describe('the mapping is total and closed', () => {
  it('produces at least one call for every operation type', () => {
    for (const type of OPERATION_TYPES) {
      expect(callsForIntent(INTENT_SAMPLES[type]).length).toBeGreaterThan(0);
    }
  });

  it('never names a function outside the allow list', () => {
    for (const type of OPERATION_TYPES) {
      for (const call of callsForIntent(INTENT_SAMPLES[type])) {
        expect(ZARYA_WRITE_FUNCTIONS).toContain(call.fn);
      }
    }
  });

  it('cannot produce executeVoting', () => {
    // The absence is the enforcement, so it gets an assertion rather than a
    // comment: nothing a document can express reaches the executor's call.
    const produced = OPERATION_TYPES.flatMap((type) =>
      callsForIntent(INTENT_SAMPLES[type]).map((call) => call.fn),
    );
    expect(produced).not.toContain('executeVoting');
    expect(ZARYA_WRITE_FUNCTIONS as readonly string[]).not.toContain('executeVoting');
    expect(ZARYA_WRITE_FUNCTIONS as readonly string[]).not.toContain('initializeOrgans');
  });
});

describe('the ten one-to-one intents', () => {
  it('each expand to exactly one call', () => {
    for (const type of OPERATION_TYPES) {
      if (type === 'CONFIGURE_ORGAN_THRESHOLDS') continue;
      expect(callsForIntent(INTENT_SAMPLES[type])).toHaveLength(1);
    }
  });

  it('carry the organ triple through unchanged, and only where the contract takes one', () => {
    for (const type of OPERATION_TYPES) {
      for (const call of callsForIntent(INTENT_SAMPLES[type])) {
        const organ = organOfCall(call);
        if (organ !== undefined) expect(organ).toEqual(SAMPLE_SOVIET);
      }
    }
    // Theme and statement take `bool isCategorical` instead, and `castVote`
    // reads the organ from the voting. An organ on any of these would be a
    // value the contract has no argument for.
    for (const type of ['CREATE_THEME_VOTING', 'CREATE_STATEMENT_VOTING', 'CAST_VOTE'] as const) {
      expect(organOfCall(callsForIntent(INTENT_SAMPLES[type])[0])).toBeUndefined();
    }
  });

  it('renames a categorical proposal’s category to the value argument', () => {
    expect(callsForIntent(INTENT_SAMPLES.CREATE_CATEGORICAL_VALUE_VOTING)[0]).toEqual({
      fn: 'createCategoricalValueVoting',
      organ: SAMPLE_SOVIET,
      at: { x: 3n, y: 7n },
      value: 5n,
      valueAuthor: INTENT_SAMPLES.CREATE_CATEGORICAL_VALUE_VOTING.valueAuthor,
      duration: 86_400,
    });
  });

  it('drops the numerical scale, which is not an argument', () => {
    // `decimals` is stored per cell and preflight has already compared it. A
    // call carrying it would suggest it is being sent.
    const call = callsForIntent(INTENT_SAMPLES.CREATE_NUMERICAL_VALUE_VOTING)[0];
    expect(call).not.toHaveProperty('decimals');
    expect(call).toMatchObject({ fn: 'createNumericalValueVoting', value: 1234n });
  });

  it('keeps a vote a direction rather than a boolean', () => {
    // The bool exists only at the encoder, so the call stays reviewable: `FOR`
    // is legible in a log and `true` is not.
    expect(callsForIntent(INTENT_SAMPLES.CAST_VOTE)[0]).toEqual({
      fn: 'castVote',
      votingId: 7n,
      direction: 'FOR',
    });
  });
});

describe('threshold configuration, which is three transactions', () => {
  it('expands to all three setters for one organ', () => {
    const calls = thresholds(10_000n);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.fn).sort()).toEqual([
      'setMinimumApprovalPercentage',
      'setMinimumApprovalPercentageBase',
      'setMinimumQuorum',
    ]);
    for (const call of calls) expect(organOfCall(call)).toEqual(SAMPLE_SOVIET);
  });

  it('writes the base last when it is being enabled', () => {
    // Eligibility is snapshotted at voting creation, so a voting created
    // between these transactions keeps what it read for its whole life. With
    // the base written last, the first two are inert on an organ still in the
    // simpleMajority fallback and the whole configuration goes live at once.
    expect(thresholds(10_000n).map((call) => call.fn)).toEqual([
      'setMinimumQuorum',
      'setMinimumApprovalPercentage',
      'setMinimumApprovalPercentageBase',
    ]);
  });

  it('writes the base first when it is being reset to zero', () => {
    // The mirror image, and the reason the order is conditional: with the base
    // last, a reset would pass through zero quorum *and* zero approval against
    // a still-live base — a window in which a single FOR vote carries a voting.
    // Written first, the organ reads as simpleMajority from that transaction on.
    expect(thresholds(0n).map((call) => call.fn)).toEqual([
      'setMinimumApprovalPercentageBase',
      'setMinimumQuorum',
      'setMinimumApprovalPercentage',
    ]);
  });

  it('still sends the two inert writes on a reset', () => {
    // They change nothing while the base is zero. They are sent so that a later
    // base-only configuration does not resurrect a quorum nobody asked for.
    const calls = thresholds(0n);
    expect(calls.map((call) => ('value' in call ? call.value : undefined))).toEqual([0n, 3n, 6600n]);
  });

  it('preserves basis points exactly, with no conversion to percent', () => {
    const calls = thresholds(10_000n);
    expect(calls).toEqual([
      { fn: 'setMinimumQuorum', organ: SAMPLE_SOVIET, value: 3n },
      { fn: 'setMinimumApprovalPercentage', organ: SAMPLE_SOVIET, value: 6600n },
      { fn: 'setMinimumApprovalPercentageBase', organ: SAMPLE_SOVIET, value: 10_000n },
    ]);
  });
});
