import { afterEach, describe, expect, it } from 'vitest';
import { type CursorKey, CursorRewindError, type CursorStore } from '../../domain/ports/CursorStore';
import { chainId, evmAddress } from '../../domain/primitives';
import { type DatabaseHandle, openDatabase } from './database';
import { MemoryCursorStore } from './memoryCursorStore';
import { SqliteCursorStore } from './sqliteCursorStore';

/**
 * One suite, both implementations.
 *
 * The monotonicity rule belongs to the **port**, not to whichever storage backs
 * it, so proving it twice against two separate suites would be proving two
 * different things. `MemoryCursorStore` is not being retired — it is the right
 * implementation for a test that does not want a file — and holding the two to
 * the same contract is what makes swapping them safe.
 */

const SEPOLIA = chainId(11155111);
const CONTRACT = evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25');

const DISCOVERY: CursorKey = {
  chainId: SEPOLIA,
  contractAddress: CONTRACT,
  projection: 'votingCreated',
};

const MATRIX: CursorKey = { ...DISCOVERY, projection: 'matrixIndex' };

interface Implementation {
  readonly name: string;
  create(): { store: CursorStore; dispose: () => void };
}

const IMPLEMENTATIONS: readonly Implementation[] = [
  {
    name: 'MemoryCursorStore',
    create: () => ({ store: new MemoryCursorStore(), dispose: () => undefined }),
  },
  {
    name: 'SqliteCursorStore',
    create: () => {
      const handle = openDatabase(':memory:');
      return { store: new SqliteCursorStore(handle.db), dispose: () => handle.close() };
    },
  },
];

for (const implementation of IMPLEMENTATIONS) {
  describe(implementation.name, () => {
    let disposers: (() => void)[] = [];
    const store = (): CursorStore => {
      const created = implementation.create();
      disposers.push(created.dispose);
      return created.store;
    };
    afterEach(() => {
      for (const dispose of disposers) dispose();
      disposers = [];
    });

    it('reports nothing projected as undefined, so a caller backfills', async () => {
      // Not zero. Zero is a real block and would skip the backfill.
      expect(await store().read(DISCOVERY)).toBeUndefined();
    });

    it('reads back what was committed', async () => {
      const cursor = store();
      await cursor.commit(DISCOVERY, 11_553_464n);
      expect(await cursor.read(DISCOVERY)).toBe(11_553_464n);
    });

    it('moves forward', async () => {
      const cursor = store();
      await cursor.commit(DISCOVERY, 100n);
      await cursor.commit(DISCOVERY, 200n);
      expect(await cursor.read(DISCOVERY)).toBe(200n);
    });

    it('accepts a commit at the same block, which is a no-op scan', async () => {
      const cursor = store();
      await cursor.commit(DISCOVERY, 100n);
      await cursor.commit(DISCOVERY, 100n);
      expect(await cursor.read(DISCOVERY)).toBe(100n);
    });

    it('refuses to move backwards rather than rewinding or ignoring', async () => {
      // Silently rewinding re-projects blocks the caller believes are done;
      // silently ignoring leaves a gap. Neither is the store's call to make.
      const cursor = store();
      await cursor.commit(DISCOVERY, 200n);
      await expect(cursor.commit(DISCOVERY, 100n)).rejects.toBeInstanceOf(CursorRewindError);
      expect(await cursor.read(DISCOVERY)).toBe(200n);
    });

    it('rewinds only when asked explicitly', async () => {
      const cursor = store();
      await cursor.commit(DISCOVERY, 200n);
      await cursor.rewind(DISCOVERY, 100n);
      expect(await cursor.read(DISCOVERY)).toBe(100n);
    });

    it('refuses a negative block number', async () => {
      const cursor = store();
      await expect(cursor.commit(DISCOVERY, -1n)).rejects.toBeInstanceOf(RangeError);
      await expect(cursor.rewind(DISCOVERY, -1n)).rejects.toBeInstanceOf(RangeError);
    });

    it('keeps projections apart while they share a deployment', async () => {
      // Discovery and the matrix index share a cursor's *blocks*, not its name.
      const cursor = store();
      await cursor.commit(DISCOVERY, 200n);
      await cursor.commit(MATRIX, 150n);
      expect(await cursor.read(DISCOVERY)).toBe(200n);
      expect(await cursor.read(MATRIX)).toBe(150n);
    });

    it('keeps deployments apart', async () => {
      // Carrying a cursor across a chain or address change would resume in the
      // middle of a history that never happened.
      const cursor = store();
      await cursor.commit(DISCOVERY, 200n);
      expect(await cursor.read({ ...DISCOVERY, chainId: chainId(1) })).toBeUndefined();
      expect(
        await cursor.read({
          ...DISCOVERY,
          contractAddress: evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD'),
        }),
      ).toBeUndefined();
    });
  });
}

describe('what only the durable one can do', () => {
  let handle: DatabaseHandle | undefined;
  afterEach(() => handle?.close());

  it('keeps a block number past 2^53 exactly', async () => {
    // The reason the column is TEXT. `node:sqlite` hands an INTEGER column back
    // as a `number`, and a block number stored that way works for Sepolia's
    // eleven million and stops working silently somewhere past 2^53.
    handle = openDatabase(':memory:');
    const cursor = new SqliteCursorStore(handle.db);
    const huge = 2n ** 60n + 12345n;
    await cursor.commit(DISCOVERY, huge);
    expect(await cursor.read(DISCOVERY)).toBe(huge);
    // And the demonstration that this is not free: a value of this size does
    // not survive a trip through `number`, which is what an INTEGER column
    // would have handed back.
    expect(BigInt(Number(huge))).not.toBe(huge);
  });

  it('survives a reopen, which is the whole point of replacing the memory one', async () => {
    handle = openDatabase(':memory:');
    // A shared in-memory database cannot outlive its handle, so the survival
    // case is covered by the operation store's temp-file test; here the claim is
    // narrower: a second store over the same handle sees the first's commit.
    await new SqliteCursorStore(handle.db).commit(DISCOVERY, 4242n);
    expect(await new SqliteCursorStore(handle.db).read(DISCOVERY)).toBe(4242n);
  });
});
