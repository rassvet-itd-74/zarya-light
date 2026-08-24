import { describe, expect, it } from 'vitest';
import { CryptoIdGenerator, SequentialIdGenerator } from './cryptoIdGenerator';

describe('CryptoIdGenerator', () => {
  it('produces distinct, recognisable references', () => {
    const generator = new CryptoIdGenerator();
    const refs = new Set(Array.from({ length: 1_000 }, () => generator.newOperationRef()));

    expect(refs.size).toBe(1_000);
    for (const ref of refs) {
      expect(ref).toMatch(/^zar-[0-9a-f-]{36}$/);
    }
  });
});

describe('SequentialIdGenerator', () => {
  // The second implementation is what makes IdGenerator a boundary rather than
  // a wrapper: issuance is testable because the reference is predictable.
  it('is deterministic', () => {
    const generator = new SequentialIdGenerator();
    expect([
      generator.newOperationRef(),
      generator.newOperationRef(),
      generator.newOperationRef(),
    ]).toEqual(['zar-test-1', 'zar-test-2', 'zar-test-3']);
  });

  it('starts over for each instance, so tests cannot leak into each other', () => {
    expect(new SequentialIdGenerator().newOperationRef()).toBe('zar-test-1');
    expect(new SequentialIdGenerator('op-').newOperationRef()).toBe('op-1');
  });
});
