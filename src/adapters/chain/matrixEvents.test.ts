import { toEventSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { MATRICIES_SOL, eventParameters, hasSoliditySource } from '../../testing/soliditySource';
import {
  CATEGORY_ADDED_EVENT,
  VALUE_ADDED_EVENT,
  VALUE_ADDED_TOPIC,
  ZaryaMatrixEvents,
  abiCarriesValueAdded,
  assertMatrixEventContract,
} from './matrixEvents';
import type { ZaryaPublicClient } from './publicClient';
import { ZARYA_ABI } from './zaryaAbi';

/**
 * The one hand-written signature in this client, pinned three ways: against the
 * source while it is here, against a literal topic hash forever, and against the
 * premise that the ABI does not carry it.
 */

const ADDRESS = '0x6b31cC58a7DC5919f460068cF68D16281F360d25' as never;

describe('the premise for hand-writing ValueAdded', () => {
  it('holds: the ABI does not declare it, while it does declare CategoryAdded', () => {
    // addValue is `external` and addCategory is `internal`, so only the second
    // is inlined into Zarya and folded into its ABI. If this ever flips, the
    // fragment below should be deleted in favour of `requireEvent`.
    expect(abiCarriesValueAdded(ZARYA_ABI)).toBe(false);
    expect(CATEGORY_ADDED_EVENT.name).toBe('CategoryAdded');
    expect(CATEGORY_ADDED_EVENT.inputs).toHaveLength(3);
  });
});

describe('the pinned topic', () => {
  it('is what the fragment hashes to', () => {
    expect(toEventSelector(VALUE_ADDED_EVENT)).toBe(VALUE_ADDED_TOPIC);
    expect(() => assertMatrixEventContract()).not.toThrow();
  });

  it('changes if any parameter type does, which is what makes it a pin', () => {
    // A wrong type is the failure this guards: the filter would match nothing at
    // all, and a projection whose job is completeness would report emptiness.
    const drifted = {
      ...VALUE_ADDED_EVENT,
      inputs: [
        { name: 'x', type: 'uint256', indexed: true },
        { name: 'y', type: 'uint256', indexed: true },
        // uint64 in the source. A plausible transcription slip.
        { name: 'value', type: 'uint256', indexed: false },
        { name: 'author', type: 'address', indexed: true },
      ],
    } as const;

    expect(toEventSelector(drifted)).not.toBe(VALUE_ADDED_TOPIC);
  });

  it('does not depend on the indexed flags, which is why the source check exists too', () => {
    // Topic hashes ignore `indexed`, so a wrong flag survives the pin above and
    // is caught only by comparing against the declaration.
    const misIndexed = {
      ...VALUE_ADDED_EVENT,
      inputs: VALUE_ADDED_EVENT.inputs.map((input) => ({ ...input, indexed: false })),
    } as const;

    expect(toEventSelector(misIndexed)).toBe(VALUE_ADDED_TOPIC);
  });
});

describe.skipIf(!hasSoliditySource(MATRICIES_SOL))('against Matricies.sol', () => {
  it('transcribes the declaration exactly, indexed flags included', () => {
    const declared = eventParameters(MATRICIES_SOL, 'ValueAdded');

    expect(declared).toEqual([
      { type: 'uint256', indexed: true, name: 'x' },
      { type: 'uint256', indexed: true, name: 'y' },
      { type: 'uint64', indexed: false, name: 'value' },
      { type: 'address', indexed: true, name: 'author' },
    ]);
    expect(VALUE_ADDED_EVENT.inputs).toEqual(declared);
  });

  it('confirms the event carries no isCategorical', () => {
    // The reason `attributeValue` exists: which matrix a value landed in is not
    // in the log and has to be inferred from the cells.
    const declared = eventParameters(MATRICIES_SOL, 'ValueAdded') ?? [];
    expect(declared.some((parameter) => parameter.type === 'bool')).toBe(false);
  });
});

/** Just enough of a client for `getLogs`. */
const clientReturning = (logs: readonly unknown[]): ZaryaPublicClient =>
  ({ getLogs: async () => logs }) as unknown as ZaryaPublicClient;

describe('scanning a window', () => {
  const events = (logs: readonly unknown[]) =>
    new ZaryaMatrixEvents(clientReturning(logs), ADDRESS);

  it('decodes both event shapes and keeps the block they sat in', async () => {
    const window = await events([
      {
        eventName: 'ValueAdded',
        args: {
          x: 3n,
          y: 7n,
          value: 42n,
          author: '0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD',
        },
        blockNumber: 100n,
      },
      {
        eventName: 'CategoryAdded',
        args: { x: 3n, y: 7n, category: 2n },
        blockNumber: 101n,
      },
    ]).scan(1n, 200n);

    expect(window).toEqual({
      fromBlock: 1n,
      toBlock: 200n,
      changes: [
        {
          kind: 'VALUE_ADDED',
          at: { x: 3n, y: 7n },
          value: 42n,
          author: '0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD',
          blockNumber: 100n,
        },
        { kind: 'CATEGORY_ADDED', at: { x: 3n, y: 7n }, category: 2n, blockNumber: 101n },
      ],
    });
  });

  it('drops a malformed log rather than projecting a partial coordinate', async () => {
    // An absent coordinate reads as "not yet indexed". A wrong one reads as a
    // fact, and a coordinate index is a document voters consult.
    const window = await events([
      { eventName: 'ValueAdded', args: { x: 3n, y: 7n, value: 42n }, blockNumber: 100n },
      { eventName: 'ValueAdded', args: { x: 3n, y: 7n, value: 42n, author: 'not-an-address' }, blockNumber: 100n },
      { eventName: 'CategoryAdded', args: { x: 3n, y: 7n, category: 2n }, blockNumber: null },
      { eventName: 'VoteCasted', args: { x: 1n, y: 1n }, blockNumber: 100n },
      { eventName: 'ValueAdded', args: undefined, blockNumber: 100n },
    ]).scan(1n, 200n);

    expect(window.changes).toEqual([]);
  });

  it('refuses an inverted window rather than scanning nothing quietly', async () => {
    await expect(events([]).scan(200n, 1n)).rejects.toThrow(RangeError);
  });
});
