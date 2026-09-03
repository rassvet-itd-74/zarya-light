import { toEventSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { MATRICIES_SOL, eventParameters, hasSoliditySource } from '../../testing/soliditySource';
import {
  CATEGORY_ADDED_EVENT,
  MATRIX_EVENT_ABI,
  VALUE_ADDED_EVENT,
  VALUE_ADDED_TOPIC,
  VOTING_FINALIZED_EVENT,
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

describe('the filter covers both routes into the index', () => {
  it('carries all six fragments, so no window needs a second request', () => {
    expect(MATRIX_EVENT_ABI.map((item) => (item as { name: string }).name)).toEqual([
      'ValueAdded',
      'CategoryAdded',
      'DecimalsVotingCreated',
      'ThemeVotingCreated',
      'StatementVotingCreated',
      'VotingFinalized',
    ]);
  });

  it('includes VotingFinalized, without which the gated half can never be released', () => {
    // setDecimals, setTheme and setStatement emit nothing. Drop this fragment
    // and every theme and statement stays pending forever, which reads as an
    // unlabelled matrix rather than as a broken filter.
    expect(VOTING_FINALIZED_EVENT.inputs).toHaveLength(4);
  });
});

describe('scanning a window', () => {
  const events = (logs: readonly unknown[]) =>
    new ZaryaMatrixEvents(clientReturning(logs), ADDRESS);

  it('decodes the applied pair and keeps the position they sat at', async () => {
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
        logIndex: 0,
      },
      {
        eventName: 'CategoryAdded',
        args: { x: 3n, y: 7n, category: 2n },
        blockNumber: 101n,
        logIndex: 4,
      },
    ]).scan(1n, 200n);

    expect(window).toEqual({
      fromBlock: 1n,
      toBlock: 200n,
      events: [
        {
          kind: 'VALUE_ADDED',
          at: { x: 3n, y: 7n },
          value: 42n,
          author: '0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD',
          position: { blockNumber: 100n, logIndex: 0 },
        },
        {
          kind: 'CATEGORY_ADDED',
          at: { x: 3n, y: 7n },
          category: 2n,
          position: { blockNumber: 101n, logIndex: 4 },
        },
      ],
    });
  });

  it('decodes the gated three plus the verdict that releases them', async () => {
    const window = await events([
      {
        eventName: 'DecimalsVotingCreated',
        args: { votingId: 1n, organ: `0x${'11'.repeat(32)}`, x: 4n, y: 9n, decimals: 2 },
        blockNumber: 100n,
        logIndex: 0,
      },
      {
        eventName: 'ThemeVotingCreated',
        args: { votingId: 2n, isCategorical: true, x: 4n, theme: 'Бюджет' },
        blockNumber: 101n,
        logIndex: 1,
      },
      {
        eventName: 'StatementVotingCreated',
        args: { votingId: 3n, isCategorical: false, x: 4n, y: 9n, statement: 'Расходы' },
        blockNumber: 102n,
        logIndex: 2,
      },
      {
        eventName: 'VotingFinalized',
        args: { votingId: 2n, success: true, forVotes: 5n, againstVotes: 0n },
        blockNumber: 500n,
        logIndex: 3,
      },
    ]).scan(1n, 600n);

    expect(window.events).toEqual([
      {
        kind: 'DECIMALS_PROPOSED',
        votingId: 1n,
        organ: `0x${'11'.repeat(32)}`,
        at: { x: 4n, y: 9n },
        decimals: 2,
        position: { blockNumber: 100n, logIndex: 0 },
      },
      {
        kind: 'THEME_PROPOSED',
        votingId: 2n,
        matrix: 'CATEGORICAL',
        x: 4n,
        text: 'Бюджет',
        position: { blockNumber: 101n, logIndex: 1 },
      },
      {
        kind: 'STATEMENT_PROPOSED',
        votingId: 3n,
        matrix: 'NUMERICAL',
        y: 9n,
        text: 'Расходы',
        position: { blockNumber: 102n, logIndex: 2 },
      },
      {
        kind: 'VOTING_FINALIZED',
        votingId: 2n,
        success: true,
        position: { blockNumber: 500n, logIndex: 3 },
      },
    ]);
  });

  it('translates isCategorical through the one conversion, not by hand', async () => {
    // A bare bool is wrong silently — it addresses the other real matrix rather
    // than failing — so the mapping is asserted in both directions.
    const window = await events([
      {
        eventName: 'ThemeVotingCreated',
        args: { votingId: 1n, isCategorical: false, x: 0n, theme: 'ч' },
        blockNumber: 1n,
        logIndex: 0,
      },
      {
        eventName: 'ThemeVotingCreated',
        args: { votingId: 2n, isCategorical: true, x: 0n, theme: 'к' },
        blockNumber: 1n,
        logIndex: 1,
      },
    ]).scan(1n, 2n);

    expect(window.events.map((event) => (event as { matrix: string }).matrix)).toEqual([
      'NUMERICAL',
      'CATEGORICAL',
    ]);
  });

  it('drops the statement event’s x, which is a gate and not an address', async () => {
    // setStatement validates a theme at x and then writes statements[kind][y].
    // Carrying the x would split one statement row into several.
    const window = await events([
      {
        eventName: 'StatementVotingCreated',
        args: { votingId: 1n, isCategorical: true, x: 77n, y: 9n, statement: 'Расходы' },
        blockNumber: 1n,
        logIndex: 0,
      },
    ]).scan(1n, 2n);

    expect(window.events[0]).not.toHaveProperty('x');
    expect(window.events[0]).toMatchObject({ y: 9n });
  });

  it('drops a malformed log rather than projecting a partial coordinate', async () => {
    // An absent coordinate reads as "not yet indexed". A wrong one reads as a
    // fact, and a coordinate index is a document voters consult.
    const window = await events([
      {
        eventName: 'ValueAdded',
        args: { x: 3n, y: 7n, value: 42n },
        blockNumber: 100n,
        logIndex: 0,
      },
      {
        eventName: 'ValueAdded',
        args: { x: 3n, y: 7n, value: 42n, author: 'not-an-address' },
        blockNumber: 100n,
        logIndex: 1,
      },
      { eventName: 'CategoryAdded', args: { x: 3n, y: 7n, category: 2n }, blockNumber: null },
      { eventName: 'VoteCasted', args: { x: 1n, y: 1n }, blockNumber: 100n, logIndex: 2 },
      { eventName: 'ValueAdded', args: undefined, blockNumber: 100n, logIndex: 3 },
      // A theme voting whose isCategorical did not decode: which matrix it
      // belongs to is unknowable, and defaulting would label the wrong one.
      {
        eventName: 'ThemeVotingCreated',
        args: { votingId: 1n, x: 0n, theme: 'Бюджет' },
        blockNumber: 100n,
        logIndex: 4,
      },
    ]).scan(1n, 200n);

    expect(window.events).toEqual([]);
  });

  it('drops a log with no usable logIndex rather than calling it zero', async () => {
    // Defaulting would turn two executions in one block into a tie the fold
    // resolves arbitrarily — and the fold's whole job at that point is to say
    // which of two themes survived.
    const window = await events([
      {
        eventName: 'CategoryAdded',
        args: { x: 3n, y: 7n, category: 2n },
        blockNumber: 100n,
        logIndex: null,
      },
      {
        eventName: 'CategoryAdded',
        args: { x: 3n, y: 8n, category: 2n },
        blockNumber: 100n,
      },
    ]).scan(1n, 200n);

    expect(window.events).toEqual([]);
  });

  it('refuses an inverted window rather than scanning nothing quietly', async () => {
    await expect(events([]).scan(200n, 1n)).rejects.toThrow(RangeError);
  });
});
