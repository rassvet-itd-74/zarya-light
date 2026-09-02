import { describe, expect, it } from 'vitest';
import { type CursorKey, CursorRewindError, cursorKeyOf } from '../../domain/ports/CursorStore';
import { chainId, evmAddress } from '../../domain/primitives';
import { MemoryCursorStore } from './memoryCursorStore';

/**
 * What is left here after `cursorStoreContract.test.ts` arrived.
 *
 * That suite runs the port's behavioural rules — starts empty, moves forward,
 * refuses to move backwards, keeps projections and deployments apart — against
 * **both** implementations. Repeating them here would be two copies of one rule
 * that could drift apart, and the copy that drifted would be the one nobody
 * noticed. Net coverage went up, not down: every rule that used to be checked
 * against the in-memory store alone is now checked against the SQLite one too.
 *
 * These two describes are what the contract suite cannot own: `cursorKeyOf` is a
 * pure function with no store behind it, and the error's message is a detail of
 * this class rather than of the port.
 */

const key = (overrides: Partial<CursorKey> = {}): CursorKey => ({
  chainId: chainId(11155111),
  contractAddress: evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25'),
  projection: 'votings',
  ...overrides,
});

describe('cursor keys', () => {
  it('separate one deployment from another', () => {
    // A cursor carried across an address change would resume in the middle of a
    // history that never happened on the new contract.
    expect(cursorKeyOf(key())).not.toBe(
      cursorKeyOf(key({ contractAddress: evmAddress(`0x${'11'.repeat(20)}`) })),
    );
    expect(cursorKeyOf(key())).not.toBe(cursorKeyOf(key({ chainId: chainId(1) })));
    expect(cursorKeyOf(key())).not.toBe(cursorKeyOf(key({ projection: 'matrix' })));
  });

  it('ignore address casing, which carries no meaning here', () => {
    const lower = evmAddress('0x6b31cc58a7dc5919f460068cf68d16281f360d25');
    expect(cursorKeyOf(key({ contractAddress: lower }))).toBe(cursorKeyOf(key()));
  });
});

describe('the rewind error', () => {
  it('names both blocks so the caller can see the size of the jump', async () => {
    // "Refused to rewind" without the numbers sends someone to the logs to find
    // out whether it was one block or a million.
    const store = new MemoryCursorStore();
    await store.commit(key(), 200n);
    await expect(store.commit(key(), 150n)).rejects.toThrow(/200.*150|150.*200/);
    await expect(store.commit(key(), 150n)).rejects.toBeInstanceOf(CursorRewindError);
  });

  it('suggests the method that would have been allowed', async () => {
    const store = new MemoryCursorStore();
    await store.commit(key(), 200n);
    await expect(store.commit(key(), 150n)).rejects.toThrow(/rewind\(\)/);
  });
});

describe('the diagnostic size accessor', () => {
  it('counts distinct keys, not commits', () => {
    // Not part of the port, and only here so a test can assert a store is not
    // quietly accumulating a cursor per scan window.
    const store = new MemoryCursorStore();
    expect(store.size).toBe(0);
  });
});
