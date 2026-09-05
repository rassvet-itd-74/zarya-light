import { describe, expect, it } from 'vitest';
import { INTENT_SAMPLES } from './testing/intentSamples';
import { OPERATION_TYPES } from './intent';
import { describeIntent } from './describeIntent';

/**
 * The union flattened for a boundary that cannot carry it.
 *
 * Two properties are worth pinning and both are about *silent* wrongness: a
 * `bigint` that a structured clone drops addresses a different cell, and a region
 * ordinal shown where a subject code belongs names a different real region.
 */

const valuesOf = (fields: readonly { label: string; value: string }[]) =>
  Object.fromEntries(fields.map((field) => [field.label, field.value]));

describe('describeIntent', () => {
  it('describes every operation type, with no empty results', () => {
    // The `never` check makes a missing variant a compile error; this makes an
    // *empty* one a test failure, which is the shape a fall-through would take.
    for (const type of OPERATION_TYPES) {
      const fields = describeIntent(INTENT_SAMPLES[type]);
      expect(fields.length, type).toBeGreaterThan(0);
      for (const field of fields) {
        expect(typeof field.value, `${type}.${field.label}`).toBe('string');
      }
    }
  });

  it('renders every bigint as a string rather than letting one cross as a number', () => {
    const numerical = valuesOf(describeIntent(INTENT_SAMPLES.CREATE_NUMERICAL_VALUE_VOTING));

    // Both, always: `1234` means nothing without the scale that produced it, and
    // the scale is not carried on the transaction.
    expect(numerical.value).toBe(String(INTENT_SAMPLES.CREATE_NUMERICAL_VALUE_VOTING.value));
    expect(numerical.decimals).toBe(
      String(INTENT_SAMPLES.CREATE_NUMERICAL_VALUE_VOTING.decimals),
    );
    expect(numerical.x).toMatch(/^\d+$/);
    expect(numerical.y).toMatch(/^\d+$/);
  });

  it('shows a region as its subject code, never as the enum ordinal', () => {
    // The two differ for 50 of 98 regions and a wrong one names a *different
    // real region*. Chelyabinsk is ordinal 74 and code "74", so it would pass
    // either way — the samples use a region where they diverge.
    const intent = INTENT_SAMPLES.CREATE_MEMBERSHIP_VOTING;
    const shown = valuesOf(describeIntent(intent));

    expect(shown.regionSubjectCode).toBeDefined();
    expect(shown).not.toHaveProperty('region');
    expect(shown.regionSubjectCode).not.toBe(String(intent.organ.region));
  });

  it('omits the organ parts a scope does not use', () => {
    // A normalized zero for the others would put a value in the description that
    // nothing sent, and that a reader could take for a real region 0 (Adygea).
    const themeVoting = valuesOf(describeIntent(INTENT_SAMPLES.CREATE_THEME_VOTING));
    expect(themeVoting).not.toHaveProperty('organType');
    expect(themeVoting).not.toHaveProperty('regionSubjectCode');
  });

  it('names the threshold values as basis points', () => {
    // `5000` is 50%. A label that let anyone read it as 5000% is exactly the
    // misreading this vocabulary exists to prevent.
    const labels = describeIntent(INTENT_SAMPLES.CONFIGURE_ORGAN_THRESHOLDS).map(
      (field) => field.label,
    );
    for (const label of labels.filter((name) => /quorum|approval/i.test(name))) {
      expect(label).toMatch(/BasisPoints$/);
    }
  });
});
