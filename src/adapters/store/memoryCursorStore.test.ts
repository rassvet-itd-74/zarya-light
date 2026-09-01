import { describe, expect, it } from 'vitest';
import { type CursorKey, CursorRewindError, cursorKeyOf } from '../../domain/ports/CursorStore';
import { chainId, evmAddress } from '../../domain/primitives';
import { MemoryCursorStore } from './memoryCursorStore';

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

describe('reading and committing', () => {
  it('starts empty, so a fresh client backfills', () => {
    expect(new MemoryCursorStore().read(key())).resolves.toBeUndefined();
  });

  it('returns what was committed', async () => {
    const store = new MemoryCursorStore();
    await store.commit(key(), 11_553_500n);
    expect(await store.read(key())).toBe(11_553_500n);
  });

  it('keeps projections independent', async () => {
    const store = new MemoryCursorStore();
    await store.commit(key({ projection: 'votings' }), 100n);
    await store.commit(key({ projection: 'matrix' }), 50n);

    expect(await store.read(key({ projection: 'votings' }))).toBe(100n);
    expect(await store.read(key({ projection: 'matrix' }))).toBe(50n);
  });

  it('allows re-committing the same block, since a re-scan is idempotent', async () => {
    const store = new MemoryCursorStore();
    await store.commit(key(), 100n);
    await expect(store.commit(key(), 100n)).resolves.toBeUndefined();
  });
});

describe('monotonicity', () => {
  it('refuses to move backwards through commit', async () => {
    // Rewinding re-projects blocks the caller believes are done, and ignoring
    // the call leaves a gap. Neither is the store's decision.
    const store = new MemoryCursorStore();
    await store.commit(key(), 200n);

    await expect(store.commit(key(), 199n)).rejects.toThrow(CursorRewindError);
    expect(await store.read(key())).toBe(200n);
  });

  it('names both blocks so the caller can see the size of the jump', async () => {
    const store = new MemoryCursorStore();
    await store.commit(key(), 200n);
    await expect(store.commit(key(), 150n)).rejects.toThrow(/200.*150|150.*200/);
  });

  it('allows a deliberate rewind', async () => {
    const store = new MemoryCursorStore();
    await store.commit(key(), 200n);
    await store.rewind(key(), 150n);
    expect(await store.read(key())).toBe(150n);
  });

  it('rejects a negative block from either path', async () => {
    const store = new MemoryCursorStore();
    await expect(store.commit(key(), -1n)).rejects.toThrow(RangeError);
    await expect(store.rewind(key(), -1n)).rejects.toThrow(RangeError);
  });
});
