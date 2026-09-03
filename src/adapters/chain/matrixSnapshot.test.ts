import { encodeFunctionResult } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ZERO_ORGAN } from '../../domain/matrix/matrix';
import type { ReadPoint } from '../../domain/ports/MatrixSnapshotReader';
import { bytes32, unixSeconds } from '../../domain/primitives';
import { ZaryaMatrixReader } from './matrixReader';
import { ZaryaMatrixSnapshot } from './matrixSnapshot';
import type { ZaryaPublicClient } from './publicClient';
import { ZARYA_ABI } from './zaryaAbi';

const ADDRESS = '0x6b31cC58a7DC5919f460068cF68D16281F360d25' as never;
const ORGAN = bytes32('0x99e1c11fb0d768f41b2a2dd99b1b9689289601d4551681713801f9d4e029ecb5');
const AUTHOR = '0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD';
const AT = { x: 3n, y: 7n };
const READ_AT: ReadPoint = { blockNumber: 900n, timestamp: unixSeconds(1_756_000_000) };

/**
 * Encodes through the ABI, so what is parsed is what a node would really send.
 *
 * The request is captured rather than ignored: several tests here assert on what
 * was *asked*, which is where the block pin and the getter choice live.
 */
const returning = (functionName: string, result: unknown) =>
  vi.fn(async (request: { readonly blockNumber?: bigint; readonly data?: string }) => {
    void request;
    return {
      data: encodeFunctionResult({ abi: ZARYA_ABI, functionName, result: result as never }),
    };
  });

const snapshotReturning = (functionName: string, result: unknown) => {
  const call = returning(functionName, result);
  const client = { call } as unknown as ZaryaPublicClient;
  return { call, snapshot: new ZaryaMatrixSnapshot(client, ADDRESS, READ_AT) };
};

describe('the empty-sample sentinel', () => {
  it('reads a zero checkpoint as NONE, not as a real zero written at the epoch', async () => {
    // getLatestCategoricalValue returns {0, address(0), 0} for a cell nothing
    // has been written to, rather than reverting. Printed as-is, that row would
    // claim a value of 0, authored by the zero address, in January 1970 — three
    // lies a voter has no way to detect.
    const { snapshot } = snapshotReturning('getCategoricalLatestValue', {
      timestamp: 0,
      author: '0x0000000000000000000000000000000000000000',
      value: 0n,
    });

    expect(await snapshot.latestValue('CATEGORICAL', AT)).toEqual({ kind: 'NONE' });
  });

  it('preserves a real value of zero, which a value-based test would have destroyed', async () => {
    // The sentinel is recognised by its timestamp, the only one of the three
    // fields that cannot occur naturally: addValue records block.timestamp.
    const { snapshot } = snapshotReturning('getNumericalLatestValue', {
      timestamp: 1_755_000_000,
      author: AUTHOR,
      value: 0n,
    });

    expect(await snapshot.latestValue('NUMERICAL', AT)).toEqual({
      kind: 'SET',
      value: 0n,
      author: AUTHOR,
      recordedAt: 1_755_000_000,
    });
  });

  it('answers undefined when the read did not answer, which is neither of those', async () => {
    const client = {
      call: async () => {
        throw new Error('connection reset');
      },
    } as unknown as ZaryaPublicClient;
    const snapshot = new ZaryaMatrixSnapshot(client, ADDRESS, READ_AT);

    expect(await snapshot.latestValue('CATEGORICAL', AT)).toBeUndefined();
  });
});

describe('the matrix a value read comes from', () => {
  it('calls the categorical getter for the categorical kind and vice versa', async () => {
    // A bare bool would be wrong silently here — it would read the other real
    // matrix — so the two getters are separate functions rather than an argument.
    const categorical = snapshotReturning('getCategoricalLatestValue', {
      timestamp: 1n,
      author: AUTHOR,
      value: 1n,
    });
    await categorical.snapshot.latestValue('CATEGORICAL', AT);
    const categoricalData = categorical.call.mock.calls[0][0] as { data: string };

    const numerical = snapshotReturning('getNumericalLatestValue', {
      timestamp: 1n,
      author: AUTHOR,
      value: 1n,
    });
    await numerical.snapshot.latestValue('NUMERICAL', AT);
    const numericalData = numerical.call.mock.calls[0][0] as { data: string };

    expect(categoricalData.data.slice(0, 10)).not.toBe(numericalData.data.slice(0, 10));
  });
});

describe('every read is pinned to the report’s block', () => {
  it('passes the block number on a cell read, an axis read, and a value read', async () => {
    // A document assembled across the moving head can show a theme from one
    // block and the value under it from another — a pairing that never existed,
    // with nothing on the page able to reveal it.
    const cell = snapshotReturning('getCategoricalCellInfo', [ORGAN, [1n], 2n]);
    await cell.snapshot.categoricalCell(AT);
    expect(cell.call.mock.calls[0][0]).toMatchObject({ blockNumber: 900n });

    const theme = snapshotReturning('getTheme', 'Бюджет');
    await theme.snapshot.theme('CATEGORICAL', 3n);
    expect(theme.call.mock.calls[0][0]).toMatchObject({ blockNumber: 900n });

    const value = snapshotReturning('getCategoricalLatestValue', {
      timestamp: 1n,
      author: AUTHOR,
      value: 1n,
    });
    await value.snapshot.latestValue('CATEGORICAL', AT);
    expect(value.call.mock.calls[0][0]).toMatchObject({ blockNumber: 900n });

    const name = snapshotReturning('getCategoryName', 'ЗА');
    await name.snapshot.categoryName(AT, 1n);
    expect(name.call.mock.calls[0][0]).toMatchObject({ blockNumber: 900n });
  });

  it('leaves an unpinned reader reading the head, which is what preflight wants', async () => {
    // The same decoding serves both, and only the pin differs. Preflight
    // predicting against an older block would predict against state the chain
    // has already left.
    const call = returning('getTheme', 'Бюджет');
    const reader = new ZaryaMatrixReader({ call } as unknown as ZaryaPublicClient, ADDRESS);

    await reader.theme('CATEGORICAL', 3n);
    expect(call.mock.calls[0][0]).not.toHaveProperty('blockNumber');
  });
});

describe('a category name', () => {
  it('is UNSET when the cell named nothing, which is an answer', async () => {
    const { snapshot } = snapshotReturning('getCategoryName', '');

    expect(await snapshot.categoryName(AT, 1n)).toEqual({ kind: 'UNSET' });
  });

  it('is addressed by coordinate, so two cells can name one number differently', async () => {
    const { call, snapshot } = snapshotReturning('getCategoryName', 'ЗА');

    await snapshot.categoryName({ x: 1n, y: 1n }, 2n);
    await snapshot.categoryName({ x: 5n, y: 5n }, 2n);
    const [first, second] = call.mock.calls.map((args) => (args[0] as { data: string }).data);

    expect(first).not.toBe(second);
  });
});

describe('choosing the block to pin to', () => {
  it('stays the confirmation depth behind the head, as discovery does', async () => {
    // Behind the head so a reorg cannot take the block out from under a document
    // someone is printing; recent enough that a non-archive node still holds the
    // state, which pinning to the index cursor could not promise.
    const client = {
      getBlockNumber: async () => 1_000n,
      getBlock: vi.fn(async () => ({ number: 988n, timestamp: 1_756_000_000n })),
    } as unknown as ZaryaPublicClient;

    const snapshot = await ZaryaMatrixSnapshot.atConfirmedHead(client, ADDRESS);

    expect(snapshot?.at).toEqual({ blockNumber: 988n, timestamp: 1_756_000_000 });
  });

  it('saturates at zero on a chain younger than the confirmation depth', async () => {
    const client = {
      getBlockNumber: async () => 3n,
      getBlock: vi.fn(async () => ({ number: 0n, timestamp: 1n })),
    } as unknown as ZaryaPublicClient;

    const snapshot = await ZaryaMatrixSnapshot.atConfirmedHead(client, ADDRESS);

    expect((client.getBlock as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
      blockNumber: 0n,
    });
    expect(snapshot?.at.blockNumber).toBe(0n);
  });

  it('returns undefined rather than falling back to the workstation clock', async () => {
    // A report with no block stamp is not a stale report, it is no report — and
    // the one thing it must never do is claim a freshness the chain did not
    // assert.
    const client = {
      getBlockNumber: async () => {
        throw new Error('connection reset');
      },
    } as unknown as ZaryaPublicClient;

    expect(await ZaryaMatrixSnapshot.atConfirmedHead(client, ADDRESS)).toBeUndefined();
  });
});

describe('the cell and axis reads are the reader’s, not a second copy', () => {
  it('translates the zero organ to UNBOUND, inherited rather than reimplemented', async () => {
    const { snapshot } = snapshotReturning('getNumericalCellInfo', [ZERO_ORGAN, 0, 0n]);

    expect(await snapshot.numericalCell(AT)).toEqual({
      binding: { kind: 'UNBOUND' },
      decimals: 0,
      sampleLength: 0n,
    });
  });

  it('reads a statement by y alone, as the contract addresses it', async () => {
    const { snapshot } = snapshotReturning('getStatement', 'Расходы');

    expect(await snapshot.statement('NUMERICAL', 7n)).toEqual({ kind: 'SET', text: 'Расходы' });
  });
});
