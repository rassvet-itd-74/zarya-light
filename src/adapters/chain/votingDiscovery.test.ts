import { encodeEventTopics, toEventSelector } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { evmAddress } from '../../domain/primitives';
import { VOTING_EVENT_ABI, ZaryaVotingDiscovery } from './votingDiscovery';
import type { ZaryaPublicClient } from './publicClient';

/**
 * Discovery against synthetic logs.
 *
 * The deployed contract has no votings yet (`nextVotingId` is 1), so the join
 * and its edge cases cannot be exercised on a fork. These build logs in the
 * shape viem's `getLogs` returns and assert the projection over them; the fork
 * test covers the shape of a real, empty scan.
 */

const ADDRESS = evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25');
const AUTHOR = '0x1111111111111111111111111111111111111111';
const ORGAN = `0x${'ab'.repeat(32)}`;

interface FakeLog {
  args: Record<string, unknown>;
  blockNumber: bigint | null;
}

const created = (
  id: bigint,
  suggestionType: number,
  blockNumber = 100n,
  overrides: Record<string, unknown> = {},
): FakeLog => ({
  args: {
    votingId: id,
    author: AUTHOR,
    startTime: 1_800_000_000n,
    endTime: 1_800_003_600n,
    suggestionType,
    ...overrides,
  },
  blockNumber,
});

const detail = (id: bigint, organ: string = ORGAN, blockNumber = 100n): FakeLog => ({
  args: { votingId: id, organ },
  blockNumber,
});

const discoveryOver = (createdLogs: FakeLog[], detailLogs: FakeLog[]) => {
  const getLogs = vi.fn(async ({ event }: { event?: unknown }) =>
    event === undefined ? detailLogs : createdLogs,
  );
  const client = { getLogs } as unknown as ZaryaPublicClient;
  return { discovery: new ZaryaVotingDiscovery(client, ADDRESS), getLogs };
};

describe('the event fragments come from the ABI', () => {
  it('carries VotingCreated and the six organ-bearing detail events', () => {
    expect(VOTING_EVENT_ABI.map((item) => (item as { name: string }).name)).toEqual([
      'VotingCreated',
      'MembershipVotingCreated',
      'MembershipRevocationVotingCreated',
      'CategoryVotingCreated',
      'DecimalsVotingCreated',
      'CategoricalValueVotingCreated',
      'NumericalValueVotingCreated',
    ]);
  });

  it('omits the two that carry no organ', () => {
    const names = VOTING_EVENT_ABI.map((item) => (item as { name: string }).name);
    expect(names).not.toContain('ThemeVotingCreated');
    expect(names).not.toContain('StatementVotingCreated');
  });

  it('keeps the topic hashes the deployed contract emits', () => {
    // Literal, because a changed parameter list changes the topic and a filter
    // on a wrong topic returns nothing at all — an empty scan looks exactly
    // like a quiet chain, so this failure would be invisible at runtime.
    const topicOf = (name: string) =>
      encodeEventTopics({ abi: VOTING_EVENT_ABI, eventName: name })[0];

    expect(topicOf('VotingCreated')).toBe(
      '0x1b86c2155638ba4f9725df6554d622b8e2e9c5c2bf2eab3a8cdc086970b00ab0',
    );
    expect(topicOf('MembershipVotingCreated')).toBe(
      '0x5e84e85bd5600ce4ca858fa13bcff75852bfad440d84ef4bb861355b097f7176',
    );
    expect(topicOf('VotingCreated')).toBe(
      toEventSelector('VotingCreated(uint256,address,uint256,uint256,uint8)'),
    );
  });

  it('indexes votingId and author, so either can filter', () => {
    // Signature topic, then one slot per indexed parameter. A filter on
    // votingId alone leaves author's slot null rather than dropping it.
    const topics = encodeEventTopics({
      abi: VOTING_EVENT_ABI,
      eventName: 'VotingCreated',
      args: { votingId: 7n },
    });
    expect(topics).toHaveLength(3);
    expect(topics[2]).toBeNull();
  });
});

describe('joining creation and detail logs', () => {
  it('attaches the organ from the matching detail log', async () => {
    const { discovery } = discoveryOver([created(1n, 0)], [detail(1n)]);
    const { records } = await discovery.scan(1n, 200n);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      votingId: 1n,
      suggestionType: 'Membership',
      governingOrgan: { kind: 'ORGAN', organ: ORGAN },
      startTime: 1_800_000_000,
      endTime: 1_800_003_600,
      blockNumber: 100n,
    });
  });

  it('reports NONE for a theme voting, which has no detail log by design', async () => {
    const { discovery } = discoveryOver([created(2n, 4)], []);
    const { records, withoutDetail } = await discovery.scan(1n, 200n);

    expect(records[0]).toMatchObject({
      suggestionType: 'Theme',
      governingOrgan: { kind: 'NONE' },
    });
    // Not a gap: nothing is missing.
    expect(withoutDetail).toEqual([]);
  });

  it('reports UNKNOWN and flags the gap when an organ-bearing detail log is missing', async () => {
    // The two logs landed either side of a window boundary. The organ is not
    // absent, it is unknown — and eligibility must be simulated, not assumed.
    const { discovery } = discoveryOver([created(3n, 0)], []);
    const { records, withoutDetail } = await discovery.scan(1n, 200n);

    expect(records[0].governingOrgan).toEqual({ kind: 'UNKNOWN' });
    expect(withoutDetail).toEqual([3n]);
  });

  it('does not attach one voting’s organ to another', async () => {
    const { discovery } = discoveryOver(
      [created(1n, 0), created(2n, 3)],
      [detail(2n)],
    );
    const { records } = await discovery.scan(1n, 200n);

    expect(records[0].governingOrgan).toEqual({ kind: 'UNKNOWN' });
    expect(records[1].governingOrgan).toEqual({ kind: 'ORGAN', organ: ORGAN });
  });

  it('returns records in ascending id whatever order the provider gave', async () => {
    const { discovery } = discoveryOver(
      [created(9n, 4, 300n), created(2n, 4, 100n), created(5n, 4, 200n)],
      [],
    );
    const { records } = await discovery.scan(1n, 400n);
    expect(records.map((r) => r.votingId)).toEqual([2n, 5n, 9n]);
  });
});

describe('malformed logs are dropped, not projected', () => {
  it('drops a log with a suggestion type outside the enum', async () => {
    const { discovery } = discoveryOver([created(1n, 8)], []);
    expect((await discovery.scan(1n, 200n)).records).toEqual([]);
  });

  it('drops a log with voting id zero', async () => {
    // votingExists refuses 0, so a log claiming it is not something to project.
    const { discovery } = discoveryOver([created(0n, 4)], []);
    expect((await discovery.scan(1n, 200n)).records).toEqual([]);
  });

  it('drops a log with no block number rather than guessing one', async () => {
    const { discovery } = discoveryOver([created(1n, 4, null as unknown as bigint)], []);
    expect((await discovery.scan(1n, 200n)).records).toEqual([]);
  });

  it('drops a log with a missing endTime instead of defaulting it', async () => {
    // A record with a wrong deadline is worse than no record: it would be
    // executed early, reverting VotingStillActive every poll.
    const { discovery } = discoveryOver(
      [created(1n, 4, 100n, { endTime: undefined })],
      [],
    );
    expect((await discovery.scan(1n, 200n)).records).toEqual([]);
  });

  it('ignores a detail log whose organ is not a bytes32', async () => {
    const { discovery } = discoveryOver([created(1n, 0)], [detail(1n, '0xnope')]);
    const { records } = await discovery.scan(1n, 200n);
    expect(records[0].governingOrgan).toEqual({ kind: 'UNKNOWN' });
  });
});

describe('the scan request', () => {
  it('filters by address and by event, not by address alone', async () => {
    const { discovery, getLogs } = discoveryOver([], []);
    await discovery.scan(10n, 20n);

    expect(getLogs).toHaveBeenCalledTimes(2);
    for (const [request] of getLogs.mock.calls) {
      expect(request).toMatchObject({ address: ADDRESS, fromBlock: 10n, toBlock: 20n });
      // Without strict, viem returns partially decoded logs with arguments
      // simply absent — which is how a wrong endTime would get projected.
      expect((request as { strict?: boolean }).strict).toBe(true);
    }
  });

  it('reports the window it scanned', async () => {
    const { discovery } = discoveryOver([], []);
    expect(await discovery.scan(10n, 20n)).toMatchObject({ fromBlock: 10n, toBlock: 20n });
  });

  it('refuses an inverted window rather than silently finding nothing', async () => {
    const { discovery } = discoveryOver([], []);
    await expect(discovery.scan(20n, 10n)).rejects.toThrow(RangeError);
  });
});
