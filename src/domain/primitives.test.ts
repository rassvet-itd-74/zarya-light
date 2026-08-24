import { describe, expect, it } from 'vitest';
import {
  InvalidPrimitiveError,
  chainId,
  evmAddress,
  operationRef,
  unixSeconds,
} from './primitives';

describe('unixSeconds', () => {
  it('accepts a non-negative integer count of seconds', () => {
    expect(unixSeconds(0)).toBe(0);
    expect(unixSeconds(1_756_000_000)).toBe(1_756_000_000);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
    'rejects %p',
    (value) => {
      expect(() => unixSeconds(value)).toThrow(InvalidPrimitiveError);
    },
  );
});

describe('chainId', () => {
  it('accepts a positive integer', () => {
    expect(chainId(11155111)).toBe(11155111);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects %p', (value) => {
    expect(() => chainId(value)).toThrow(InvalidPrimitiveError);
  });
});

describe('evmAddress', () => {
  it('accepts a 20-byte hex address and preserves checksum casing', () => {
    const mixedCase = '0x6b31cC58a7DC5919f460068cF68D16281F360d25';
    expect(evmAddress(mixedCase)).toBe(mixedCase);
  });

  it.each([
    ['no 0x prefix', '6b31cC58a7DC5919f460068cF68D16281F360d25'],
    ['too short', '0x6b31cC58a7DC5919f460068cF68D16281F360d2'],
    ['too long', '0x6b31cC58a7DC5919f460068cF68D16281F360d255'],
    ['non-hex character', '0x6b31cC58a7DC5919f460068cF68D16281F360dZZ'],
    ['empty', ''],
  ])('rejects %s', (_name, value) => {
    expect(() => evmAddress(value)).toThrow(InvalidPrimitiveError);
  });
});

describe('operationRef', () => {
  it('accepts a bounded non-empty reference', () => {
    expect(operationRef('zar-1')).toBe('zar-1');
  });

  it.each([
    ['empty', ''],
    ['leading whitespace', ' zar-1'],
    ['trailing whitespace', 'zar-1\n'],
    // A returned form is untrusted, so a "reference" it presents must not be
    // able to be arbitrarily long.
    ['over the length bound', `zar-${'x'.repeat(200)}`],
  ])('rejects %s', (_name, value) => {
    expect(() => operationRef(value)).toThrow(InvalidPrimitiveError);
  });
});
