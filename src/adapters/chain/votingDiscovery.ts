import type { Abi } from 'viem';
import type { ScannedWindow, VotingDiscovery } from '../../domain/ports/VotingDiscovery';
import {
  type Bytes32,
  type EvmAddress,
  bytes32,
  evmAddress,
  unixSeconds,
} from '../../domain/primitives';
import {
  type SuggestionType,
  type VotingRecord,
  governingOrganFrom,
  suggestionTypeByOrdinal,
  votingId,
} from '../../domain/voting/voting';
import type { ZaryaPublicClient } from './publicClient';
import { requireEvent } from './zaryaAbi';

/**
 * Projecting votings from their creation events.
 *
 * Two log families, joined by `votingId`:
 *
 * - **`VotingCreated`** — the discovery primitive, and the only carrier of
 *   `endTime`. Without it a client cannot say when a voting closes, because no
 *   getter reports it.
 * - **the per-type detail event** — the only carrier of the governing organ,
 *   which `castVote` needs and no getter returns.
 *
 * Six of the eight detail events carry an organ; `ThemeVotingCreated` and
 * `StatementVotingCreated` carry none, correctly, because those votings have
 * none and anyone may vote on them. A voting whose detail log is missing gets
 * `UNKNOWN`, never `NONE` — see `governingOrganFrom`.
 */

/**
 * Taken from the bundled ABI, not transcribed.
 *
 * The `Votings` library's functions are `internal`, so solc inlines them and
 * their events reach the contract's ABI — only `Matricies.ValueAdded` is absent,
 * because that library's functions are `external`. So there is nothing to
 * hand-write here, and `requireEvent` asserts at load that each fragment is
 * present exactly once with the expected parameter count.
 */
const VOTING_CREATED = requireEvent('VotingCreated', 5);

/**
 * The six detail events that carry an organ.
 *
 * `ThemeVotingCreated` and `StatementVotingCreated` are deliberately absent:
 * those votings have no organ and anyone may vote on them, so there is nothing
 * to look up and their omission here is what makes `governingOrganFrom` report
 * `NONE` rather than `UNKNOWN` for them.
 */
const DETAIL_EVENTS: ReadonlyArray<readonly [SuggestionType, ReturnType<typeof requireEvent>]> = [
  ['Membership', requireEvent('MembershipVotingCreated', 3)],
  ['MembershipRevocation', requireEvent('MembershipRevocationVotingCreated', 3)],
  ['Category', requireEvent('CategoryVotingCreated', 6)],
  ['Decimals', requireEvent('DecimalsVotingCreated', 5)],
  ['CategoricalValue', requireEvent('CategoricalValueVotingCreated', 6)],
  ['NumericalValue', requireEvent('NumericalValueVotingCreated', 6)],
];

export const VOTING_EVENT_ABI: Abi = [VOTING_CREATED, ...DETAIL_EVENTS.map(([, event]) => event)];

/** Every detail event that carries an organ, for the log filter. */
const ORGAN_DETAIL_ABI: Abi = DETAIL_EVENTS.map(([, event]) => event);

export class ZaryaVotingDiscovery implements VotingDiscovery {
  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
  ) {}

  async scan(fromBlock: bigint, toBlock: bigint): Promise<ScannedWindow> {
    if (toBlock < fromBlock) {
      throw new RangeError(`empty scan window: ${fromBlock}..${toBlock}`);
    }

    // Two filtered requests rather than one unfiltered sweep of the address:
    // the Zarya address also carries VoteCasted, VotingFinalized, ValueAdded and
    // CategoryAdded, and pulling those here would grow with vote traffic while
    // adding nothing this projection reads.
    //
    // `strict` matters. Left off, viem returns logs that only partially decode,
    // with missing arguments simply absent — a partially decoded VotingCreated
    // would yield a record with a wrong or missing endTime, which is worse than
    // no record at all. Strict drops them, and a dropped VotingCreated reads as
    // an unknown voting.
    const [created, details] = await Promise.all([
      this.client.getLogs({
        address: this.address,
        event: VOTING_CREATED,
        fromBlock,
        toBlock,
        strict: true,
      }),
      this.client.getLogs({
        address: this.address,
        events: ORGAN_DETAIL_ABI,
        fromBlock,
        toBlock,
        strict: true,
      }),
    ]);

    const organs = organsByVotingId(details);
    const records: VotingRecord[] = [];
    const withoutDetail: bigint[] = [];

    for (const log of created) {
      const record = toRecord(log, organs);
      if (record === undefined) continue;
      records.push(record);
      if (record.governingOrgan.kind === 'UNKNOWN') {
        withoutDetail.push(record.votingId as bigint);
      }
    }

    // Ascending id, so a caller projecting in order sees votings as they were
    // created regardless of how the provider ordered the logs.
    records.sort((a, b) => (a.votingId < b.votingId ? -1 : a.votingId > b.votingId ? 1 : 0));

    return { fromBlock, toBlock, records, withoutDetail };
  }
}

/**
 * The shape this projection reads, kept structural rather than borrowing viem's
 * `Log` generic — which resolves differently depending on how the filter was
 * built and fights every attempt to hold both variants in one signature.
 */
interface DecodedLog {
  readonly args?: unknown;
  readonly blockNumber?: bigint | null;
}

const organsByVotingId = (logs: readonly DecodedLog[]): Map<bigint, Bytes32> => {
  const organs = new Map<bigint, Bytes32>();
  for (const log of logs) {
    const args = log.args as { votingId?: unknown; organ?: unknown } | undefined;
    if (typeof args?.votingId !== 'bigint' || typeof args.organ !== 'string') continue;
    try {
      organs.set(args.votingId, bytes32(args.organ));
    } catch {
      // A malformed organ is left out, so the voting reads UNKNOWN and forces a
      // simulation rather than carrying a hash nobody validated.
      continue;
    }
  }
  return organs;
};

const toRecord = (
  log: DecodedLog,
  organs: ReadonlyMap<bigint, Bytes32>,
): VotingRecord | undefined => {
  const args = log.args as
    | {
        votingId?: unknown;
        author?: unknown;
        startTime?: unknown;
        endTime?: unknown;
        suggestionType?: unknown;
      }
    | undefined;

  if (
    typeof args?.votingId !== 'bigint' ||
    typeof args.author !== 'string' ||
    typeof args.startTime !== 'bigint' ||
    typeof args.endTime !== 'bigint' ||
    typeof args.suggestionType !== 'number' ||
    log.blockNumber === null ||
    log.blockNumber === undefined
  ) {
    return undefined;
  }
  const blockNumber = log.blockNumber;

  try {
    const suggestionType = suggestionTypeByOrdinal(args.suggestionType);
    return {
      votingId: votingId(args.votingId),
      author: evmAddress(args.author),
      // uint256 on chain and a JS number here: a timestamp beyond 2^53 seconds
      // is not a date, and unixSeconds refuses it rather than silently rounding.
      startTime: unixSeconds(Number(args.startTime)),
      endTime: unixSeconds(Number(args.endTime)),
      suggestionType,
      governingOrgan: governingOrganFrom(suggestionType, organs.get(args.votingId)),
      blockNumber,
    };
  } catch {
    // A malformed log is dropped, not projected as a partial record. Its
    // votingId then has no endTime, which reads as an unknown voting rather
    // than as one with a wrong deadline.
    return undefined;
  }
};
