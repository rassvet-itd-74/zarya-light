import { describe, expect, it } from 'vitest';
import { chainId, evmAddress } from '../primitives';
import { INTENT_SAMPLES } from './testing/intentSamples';
import { OPERATION_TYPES } from './intent';
import { canonicalIdentity, voteDirectionOf } from './operationIdentity';

/**
 * What counts as the same operation.
 *
 * The failures that matter here are both silent: two different operations
 * sharing a key would suppress a legitimate second submission, and one operation
 * producing two keys would let it submit twice.
 */

const SCOPE = {
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
};

const OTHER_CONTRACT = {
  ...SCOPE,
  contractAddress: evmAddress('0x141eb271Fb1eD3D0D0e9E0E7C1E51b1E5aB3C0f1'),
};

const idOf = (type: keyof typeof INTENT_SAMPLES, scope = SCOPE) =>
  canonicalIdentity(INTENT_SAMPLES[type], scope);

describe('canonicalIdentity', () => {
  it('gives every operation type a key, and no two the same', () => {
    const keys = OPERATION_TYPES.map((type) => idOf(type));
    expect(new Set(keys).size).toBe(OPERATION_TYPES.length);
  });

  it('is stable across calls', () => {
    for (const type of OPERATION_TYPES) expect(idOf(type)).toBe(idOf(type));
  });

  it('separates deployments', () => {
    // A form issued against the other deployment must never dedup against this
    // one. Two incompatible deployments exist.
    for (const type of OPERATION_TYPES) {
      expect(idOf(type, OTHER_CONTRACT), type).not.toBe(idOf(type));
    }
  });

  it('ignores a vote’s direction, so opposite votes collide', () => {
    // The collision is the feature: two forms voting opposite ways on one voting
    // are a contradiction to surface, not two operations to submit. Folding the
    // direction in would make them unrelated and both would go.
    const forVote = INTENT_SAMPLES.CAST_VOTE;
    const against = { ...forVote, direction: 'AGAINST' as const };

    expect(canonicalIdentity(against, SCOPE)).toBe(canonicalIdentity(forVote, SCOPE));
    expect(voteDirectionOf(forVote)).toBe('FOR');
    expect(voteDirectionOf(against)).toBe('AGAINST');
    expect(voteDirectionOf(INTENT_SAMPLES.CREATE_THEME_VOTING)).toBeUndefined();
  });

  it('distinguishes the same number written at different scales', () => {
    // `1234` at two decimals and `12340` at three are the same quantity. A key
    // holding only the integer would call them different operations; one holding
    // only the scale would call every value in a cell the same one.
    const base = INTENT_SAMPLES.CREATE_NUMERICAL_VALUE_VOTING;
    const scaledUp = { ...base, value: base.value * 10n, decimals: base.decimals + 1 };

    expect(canonicalIdentity(scaledUp, SCOPE)).not.toBe(canonicalIdentity(base, SCOPE));
  });

  it('cannot be fooled by moving a character between components', () => {
    // Length-prefixed rather than delimiter-joined: two themes that differ only
    // in where a boundary falls must not produce one key.
    const theme = INTENT_SAMPLES.CREATE_THEME_VOTING;
    const a = canonicalIdentity({ ...theme, theme: 'ab', x: 1n }, SCOPE);
    const b = canonicalIdentity({ ...theme, theme: 'b', x: 1n }, SCOPE);

    expect(a).not.toBe(b);
  });

  it('keys an organ by subject code, never by the enum ordinal', () => {
    const intent = INTENT_SAMPLES.CREATE_MEMBERSHIP_VOTING;
    const key = canonicalIdentity(intent, SCOPE);

    // The samples use a region whose ordinal and code differ, so a key built
    // from the ordinal would be visibly different from this one.
    expect(key).not.toContain(`:${String(intent.organ.region)}`);
  });
});
