import { describe, expect, it } from 'vitest';
import { FixedPointError, formatFixedPoint, parseFixedPoint } from './fixedPoint';

describe('scaling a written value', () => {
  it('scales by the cell’s decimals', () => {
    expect(parseFixedPoint('12.34', 2)).toBe(1234n);
    expect(parseFixedPoint('12', 2)).toBe(1200n);
    expect(parseFixedPoint('12.3', 2)).toBe(1230n);
    expect(parseFixedPoint('0', 0)).toBe(0n);
    expect(parseFixedPoint('7', 0)).toBe(7n);
  });

  it('treats a zero value as a value, not as absence', () => {
    expect(parseFixedPoint('0.00', 2)).toBe(0n);
  });
});

describe('the rejection policy', () => {
  it('refuses a value more precise than the cell, rather than rounding it', () => {
    // The rule this module exists for: rounding turns a typo into a proposal
    // people vote on. There is no flag to enable it.
    expect(() => parseFixedPoint('12.345', 2)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('1.5', 0)).toThrow(FixedPointError);
  });

  it('names both numbers, so a member knows which way to change it', () => {
    expect(() => parseFixedPoint('12.345', 2)).toThrow(/2 decimal place\(s\) and this value has 3/);
  });

  it('refuses a sign, an exponent, or separators', () => {
    // A leading minus accepted and then discarded is worse than a refusal, and
    // `1,234` means two different numbers to two readers.
    expect(() => parseFixedPoint('-1', 2)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('+1', 2)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('1e3', 2)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('1,234', 2)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('1 234', 2)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('1.', 2)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('.5', 2)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('', 2)).toThrow(FixedPointError);
  });

  it('does not trim, because trimming is the caller’s decision made once', () => {
    expect(() => parseFixedPoint(' 12.34 ', 2)).toThrow(FixedPointError);
  });

  it('refuses a result outside uint64', () => {
    const max = (1n << 64n) - 1n;
    expect(parseFixedPoint(max.toString(), 0)).toBe(max);
    expect(() => parseFixedPoint((max + 1n).toString(), 0)).toThrow(/uint64/);
    // The overflow that a scale creates rather than the digits.
    expect(() => parseFixedPoint('1', 20)).toThrow(/uint64/);
  });

  it('refuses a scale outside uint8', () => {
    expect(() => parseFixedPoint('1', -1)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('1', 256)).toThrow(FixedPointError);
    expect(() => parseFixedPoint('1', 1.5)).toThrow(FixedPointError);
  });
});

describe('rendering a stored value', () => {
  it('is the exact inverse, keeping the cell’s own precision', () => {
    expect(formatFixedPoint(1234n, 2)).toBe('12.34');
    // Trailing zeros stay: 1.50 at two decimals is what the cell holds, and
    // trimming would render something that no longer round-trips.
    expect(formatFixedPoint(1500n, 2)).toBe('15.00');
    expect(formatFixedPoint(7n, 0)).toBe('7');
  });

  it('pads a value smaller than its own scale', () => {
    expect(formatFixedPoint(5n, 2)).toBe('0.05');
    expect(formatFixedPoint(0n, 2)).toBe('0.00');
    expect(formatFixedPoint(0n, 4)).toBe('0.0000');
  });

  it('round-trips every value at every scale it was written with', () => {
    for (const decimals of [0, 1, 2, 6, 18]) {
      for (const value of [0n, 1n, 5n, 999n, 1_000_000n]) {
        expect(parseFixedPoint(formatFixedPoint(value, decimals), decimals)).toBe(value);
      }
    }
  });

  it('refuses to render what could not be stored', () => {
    expect(() => formatFixedPoint(-1n, 2)).toThrow(FixedPointError);
    expect(() => formatFixedPoint(1n << 64n, 2)).toThrow(FixedPointError);
  });
});
