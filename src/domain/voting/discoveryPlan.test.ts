import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIRMATIONS,
  DEFAULT_MAX_BLOCKS_PER_SCAN,
  type DiscoveryInputs,
  planDiscovery,
  hasMoreToScan,
} from './discoveryPlan';

const DEPLOYMENT = 11_553_464n;

const inputs = (overrides: Partial<DiscoveryInputs> = {}): DiscoveryInputs => ({
  cursor: undefined,
  headBlock: DEPLOYMENT + 100_000n,
  deploymentBlock: DEPLOYMENT,
  ...overrides,
});

describe('a fresh client', () => {
  it('starts at the deployment block, never at genesis', () => {
    const plan = planDiscovery(inputs());
    expect(plan).toMatchObject({ kind: 'SCAN', fromBlock: DEPLOYMENT });
  });

  it('bounds the first window rather than asking for the whole history', () => {
    const plan = planDiscovery(inputs());
    expect(plan.kind).toBe('SCAN');
    if (plan.kind !== 'SCAN') return;
    expect(plan.toBlock - plan.fromBlock + 1n).toBe(DEFAULT_MAX_BLOCKS_PER_SCAN);
  });

  it('reports that a backfill has further to go', () => {
    const given = inputs();
    expect(hasMoreToScan(planDiscovery(given), given)).toBe(true);
  });
});

describe('staying behind the head', () => {
  it('never scans within the confirmation depth', () => {
    const head = DEPLOYMENT + 1_000n;
    const plan = planDiscovery(inputs({ headBlock: head, cursor: DEPLOYMENT + 500n }));

    expect(plan).toMatchObject({ kind: 'SCAN', toBlock: head - DEFAULT_CONFIRMATIONS });
  });

  it('does nothing when the confirmed head is still below the deployment', () => {
    // A chain that has barely advanced past deployment, or a devnet whose head
    // is below the confirmation depth entirely.
    expect(planDiscovery(inputs({ headBlock: DEPLOYMENT + 1n })).kind).toBe('UP_TO_DATE');
    expect(planDiscovery(inputs({ headBlock: 3n, deploymentBlock: 0n })).kind).toBe(
      'UP_TO_DATE',
    );
  });

  it('does not underflow on a head below the confirmation depth', () => {
    expect(() => planDiscovery(inputs({ headBlock: 0n, deploymentBlock: 0n }))).not.toThrow();
    expect(planDiscovery(inputs({ headBlock: 0n, deploymentBlock: 0n })).kind).toBe(
      'UP_TO_DATE',
    );
  });
});

describe('resuming from a cursor', () => {
  it('starts at the block after the cursor, since the cursor is inclusive', () => {
    const cursor = DEPLOYMENT + 4_000n;
    expect(planDiscovery(inputs({ cursor }))).toMatchObject({
      kind: 'SCAN',
      fromBlock: cursor + 1n,
    });
  });

  it('is up to date when the cursor covers everything confirmed', () => {
    const head = DEPLOYMENT + 1_000n;
    expect(
      planDiscovery(inputs({ headBlock: head, cursor: head - DEFAULT_CONFIRMATIONS })).kind,
    ).toBe('UP_TO_DATE');
  });

  it('stops short of the window cap on the final chunk', () => {
    const head = DEPLOYMENT + 1_000n;
    const cursor = DEPLOYMENT + 900n;
    const plan = planDiscovery(inputs({ headBlock: head, cursor }));

    expect(plan).toMatchObject({
      kind: 'SCAN',
      fromBlock: cursor + 1n,
      toBlock: head - DEFAULT_CONFIRMATIONS,
    });
    expect(hasMoreToScan(plan, inputs({ headBlock: head, cursor }))).toBe(false);
  });

  it('reports a cursor ahead of the confirmed head instead of rewinding it', () => {
    // A reorg, a stale head from a load-balanced provider, or a cursor carried
    // across a chain change. Rewinding re-projects and advancing hides a gap,
    // so neither is decided here.
    const head = DEPLOYMENT + 1_000n;
    expect(planDiscovery(inputs({ headBlock: head, cursor: head + 50n }))).toMatchObject({
      kind: 'CURSOR_AHEAD',
      cursor: head + 50n,
      confirmedHead: head - DEFAULT_CONFIRMATIONS,
    });
  });

  it('walks a backfill to completion in bounded windows', () => {
    const head = DEPLOYMENT + 12_000n;
    const confirmedHead = head - DEFAULT_CONFIRMATIONS;
    let cursor: bigint | undefined = undefined;
    const windows: Array<[bigint, bigint]> = [];

    for (let guard = 0; guard < 10; guard += 1) {
      const plan = planDiscovery(inputs({ headBlock: head, cursor }));
      if (plan.kind !== 'SCAN') break;
      windows.push([plan.fromBlock, plan.toBlock]);
      cursor = plan.toBlock;
    }

    // Contiguous, no gaps and no overlaps — the property that makes a resumed
    // scan equivalent to an uninterrupted one.
    expect(windows[0][0]).toBe(DEPLOYMENT);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i][0]).toBe(windows[i - 1][1] + 1n);
    }
    expect(windows.at(-1)?.[1]).toBe(confirmedHead);
    expect(planDiscovery(inputs({ headBlock: head, cursor })).kind).toBe('UP_TO_DATE');
  });
});

describe('window sizing', () => {
  it('honours a custom cap', () => {
    const plan = planDiscovery(inputs({ maxBlocksPerScan: 10n }));
    expect(plan).toMatchObject({ kind: 'SCAN', fromBlock: DEPLOYMENT, toBlock: DEPLOYMENT + 9n });
  });

  it('honours a custom confirmation depth', () => {
    const head = DEPLOYMENT + 1_000n;
    expect(
      planDiscovery(inputs({ headBlock: head, cursor: DEPLOYMENT, confirmations: 0n })),
    ).toMatchObject({ toBlock: head });
  });

  it('rejects a non-positive cap rather than looping forever', () => {
    expect(() => planDiscovery(inputs({ maxBlocksPerScan: 0n }))).toThrow(RangeError);
  });
});
