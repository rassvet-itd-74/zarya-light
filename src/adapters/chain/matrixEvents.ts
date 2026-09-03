import { type Abi, type AbiEvent, toEventSelector } from 'viem';
import { matrixCoordinate } from '../../domain/matrix/matrix';
import type { LogPosition, MatrixIndexEvent } from '../../domain/matrix/matrixIndex';
import type { MatrixIndex, ScannedIndexWindow } from '../../domain/ports/MatrixIndex';
import { type EvmAddress, bytes32, evmAddress } from '../../domain/primitives';
import { matrixKindOf } from './matrixReader';
import type { ZaryaPublicClient } from './publicClient';
import { AbiContractError, ZARYA_ABI, requireEvent } from './zaryaAbi';

/**
 * Every log the coordinate index is built from, and the one hand-written ABI
 * fragment in this client.
 *
 * Six fragments in two families. **Applied** — `ValueAdded` and `CategoryAdded`,
 * which fire from inside `_executeApprovedSuggestion` and are therefore their own
 * evidence that a voting passed. **Gated** — the decimals, theme and statement
 * creation events plus `VotingFinalized`, because those three mutations emit
 * nothing when they run and can only be observed as a proposal joined to its
 * verdict.
 *
 * `CategoryAdded` is in the contract's ABI. `ValueAdded` is not, and the reason
 * is worth stating precisely, because it is not "the ABI is incomplete":
 *
 * - `Matricies.addCategory` is `internal`, so solc inlines it into Zarya and its
 *   event folds into Zarya's ABI.
 * - `Matricies.addValue` is `external`, so `Matricies` is deployed as a linked
 *   library and called by `DELEGATECALL`. Solidity does not fold an
 *   externally-linked library's events into the calling contract's ABI, so
 *   `ValueAdded` is absent from it — while still being emitted **at the Zarya
 *   address**, because `DELEGATECALL` keeps the caller's context.
 *
 * So the log is there to be subscribed to and only its description is missing.
 * That description is written out below, once, and pinned two ways: against the
 * declaration in `Matricies.sol` while that file is in the tree, and against a
 * literal topic hash that depends on no file at all.
 */

/**
 * `Matricies.sol:45`, transcribed — the only signature in this codebase that is.
 *
 * Three of its four parameters are indexed, which is what makes it a usable
 * coordinate source: `x` and `y` can be filtered on directly.
 */
export const VALUE_ADDED_EVENT = {
  type: 'event',
  name: 'ValueAdded',
  inputs: [
    { name: 'x', type: 'uint256', indexed: true },
    { name: 'y', type: 'uint256', indexed: true },
    { name: 'value', type: 'uint64', indexed: false },
    { name: 'author', type: 'address', indexed: true },
  ],
} as const satisfies AbiEvent;

/**
 * `keccak256("ValueAdded(uint256,uint256,uint64,address)")`.
 *
 * Pinned as a literal so the transcription above is checked by something that
 * outlives `temporal_docs/`. A mistyped parameter type would change this hash,
 * and a filter built on a wrong topic silently matches nothing at all — the
 * quietest possible failure for a projection whose whole job is completeness.
 */
export const VALUE_ADDED_TOPIC =
  '0x21cc4975570042bb795003432bd226f55b21e68635744608d88dd803ae269f14' as const;

/** From the ABI, because this one is in it. */
export const CATEGORY_ADDED_EVENT = requireEvent('CategoryAdded', 3);

/**
 * The gated half, and the verdict that releases it.
 *
 * `Matricies.setDecimals`, `setTheme` and `setStatement` emit **nothing** when
 * they run, so unlike a value or a category there is no applied event to
 * subscribe to. The only evidence a theme changed is its creation event joined to
 * `VotingFinalized(success = true)` — which is why these four fragments are here
 * rather than in `votingDiscovery`, whose join answers a different question.
 *
 * All four are in the ABI: the `Votings` library's functions are `internal`, so
 * solc inlines them and their events survive into it. Only `Matricies`' events
 * go missing.
 */
export const DECIMALS_VOTING_CREATED_EVENT = requireEvent('DecimalsVotingCreated', 5);
export const THEME_VOTING_CREATED_EVENT = requireEvent('ThemeVotingCreated', 4);
export const STATEMENT_VOTING_CREATED_EVENT = requireEvent('StatementVotingCreated', 5);
export const VOTING_FINALIZED_EVENT = requireEvent('VotingFinalized', 4);

/**
 * One filter for all six.
 *
 * `votingDiscovery` splits its requests to keep unrelated traffic out; here
 * every fragment is one the index reads, so splitting would buy nothing and cost
 * a round trip. Distinct `topic0` values make it a single OR filter.
 */
export const MATRIX_EVENT_ABI: Abi = [
  VALUE_ADDED_EVENT,
  CATEGORY_ADDED_EVENT,
  DECIMALS_VOTING_CREATED_EVENT,
  THEME_VOTING_CREATED_EVENT,
  STATEMENT_VOTING_CREATED_EVENT,
  VOTING_FINALIZED_EVENT,
];

/**
 * Asserted at load, next to the ABI's own contract check.
 *
 * The topic is recomputed from the fragment rather than trusted, so an edit to
 * the fragment that does not also update the literal fails here rather than in a
 * scan that returns nothing.
 */
export function assertMatrixEventContract(): void {
  const computed = toEventSelector(VALUE_ADDED_EVENT);
  if (computed !== VALUE_ADDED_TOPIC) {
    throw new AbiContractError(
      `the hand-written ValueAdded fragment hashes to ${computed}, not the pinned ${VALUE_ADDED_TOPIC}`,
    );
  }
}

assertMatrixEventContract();

/** Whether the bundled ABI carries `ValueAdded` — it does not, and that is the premise. */
export const abiCarriesValueAdded = (abi: Abi = ZARYA_ABI): boolean =>
  abi.some((item) => item.type === 'event' && item.name === 'ValueAdded');

/**
 * Scans one block window for everything the coordinate index folds.
 *
 * Deliberately not a projection: it takes the window it is given and reports what
 * is in it, exactly as `ZaryaVotingDiscovery.scan` does, so both consume the one
 * cursor `planDiscovery` advances rather than sweeping independently. The gating
 * — which proposals became real — happens in `foldMatrixIndexWindow`, where it
 * can be tested without a chain.
 */
export class ZaryaMatrixEvents implements MatrixIndex {
  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
  ) {}

  async scan(fromBlock: bigint, toBlock: bigint): Promise<ScannedIndexWindow> {
    if (toBlock < fromBlock) {
      throw new RangeError(`empty scan window: ${fromBlock}..${toBlock}`);
    }

    // `strict` for the same reason discovery uses it: a partially decoded log
    // arrives with arguments simply missing, and a coordinate index built from
    // one would carry a wrong `(x, y)` rather than no entry.
    const logs = await this.client.getLogs({
      address: this.address,
      events: MATRIX_EVENT_ABI,
      fromBlock,
      toBlock,
      strict: true,
    });

    const events: MatrixIndexEvent[] = [];
    for (const log of logs) {
      const event = toIndexEvent(log as DecodedMatrixLog);
      if (event !== undefined) events.push(event);
    }
    return { fromBlock, toBlock, events };
  }
}

/**
 * Structural rather than viem's `Log` generic, which resolves differently
 * depending on how the filter was built.
 */
interface DecodedMatrixLog {
  readonly eventName?: string;
  readonly args?: unknown;
  readonly blockNumber?: bigint | null;
  readonly logIndex?: number | null;
}

/**
 * A log's total-order position.
 *
 * `logIndex` is required, not defaulted to zero. Two theme votings executed in
 * one block are ordered by it and nothing else, and a default would silently
 * make them a tie that the fold resolves arbitrarily.
 */
const positionOf = (log: DecodedMatrixLog): LogPosition | undefined => {
  const { blockNumber, logIndex } = log;
  if (blockNumber === null || blockNumber === undefined) return undefined;
  if (typeof logIndex !== 'number' || !Number.isInteger(logIndex) || logIndex < 0) return undefined;
  return { blockNumber, logIndex };
};

interface MatrixLogArgs {
  readonly x?: unknown;
  readonly y?: unknown;
  readonly value?: unknown;
  readonly author?: unknown;
  readonly category?: unknown;
  readonly votingId?: unknown;
  readonly organ?: unknown;
  readonly decimals?: unknown;
  readonly isCategorical?: unknown;
  readonly theme?: unknown;
  readonly statement?: unknown;
  readonly success?: unknown;
}

/**
 * One decoded log to one index event, or nothing.
 *
 * Every arm drops rather than repairs. A partial coordinate reads as "not yet
 * indexed", which a later rescan fixes; a repaired one reads as a fact on a page
 * a voter transcribes from.
 */
const toIndexEvent = (log: DecodedMatrixLog): MatrixIndexEvent | undefined => {
  const position = positionOf(log);
  if (position === undefined) return undefined;
  const args = log.args as MatrixLogArgs | undefined;
  if (args === undefined) return undefined;

  try {
    switch (log.eventName) {
      case 'ValueAdded': {
        if (typeof args.x !== 'bigint' || typeof args.y !== 'bigint') return undefined;
        if (typeof args.value !== 'bigint' || typeof args.author !== 'string') return undefined;
        return {
          kind: 'VALUE_ADDED',
          at: matrixCoordinate(args.x, args.y),
          value: args.value,
          author: evmAddress(args.author),
          position,
        };
      }

      case 'CategoryAdded': {
        if (typeof args.x !== 'bigint' || typeof args.y !== 'bigint') return undefined;
        if (typeof args.category !== 'bigint') return undefined;
        return {
          kind: 'CATEGORY_ADDED',
          at: matrixCoordinate(args.x, args.y),
          category: args.category,
          position,
        };
      }

      case 'DecimalsVotingCreated': {
        if (typeof args.votingId !== 'bigint' || typeof args.organ !== 'string') return undefined;
        if (typeof args.x !== 'bigint' || typeof args.y !== 'bigint') return undefined;
        if (typeof args.decimals !== 'number') return undefined;
        return {
          kind: 'DECIMALS_PROPOSED',
          votingId: args.votingId,
          organ: bytes32(args.organ),
          at: matrixCoordinate(args.x, args.y),
          decimals: args.decimals,
          position,
        };
      }

      case 'ThemeVotingCreated': {
        if (typeof args.votingId !== 'bigint' || typeof args.isCategorical !== 'boolean') {
          return undefined;
        }
        if (typeof args.x !== 'bigint' || typeof args.theme !== 'string') return undefined;
        return {
          kind: 'THEME_PROPOSED',
          votingId: args.votingId,
          matrix: matrixKindOf(args.isCategorical),
          x: args.x,
          text: args.theme,
          position,
        };
      }

      case 'StatementVotingCreated': {
        if (typeof args.votingId !== 'bigint' || typeof args.isCategorical !== 'boolean') {
          return undefined;
        }
        // The event's `x` is read and discarded: `setStatement` uses it only to
        // require a theme there and then writes by `y`. See the note on
        // `STATEMENT_PROPOSED`.
        if (typeof args.y !== 'bigint' || typeof args.statement !== 'string') return undefined;
        return {
          kind: 'STATEMENT_PROPOSED',
          votingId: args.votingId,
          matrix: matrixKindOf(args.isCategorical),
          y: args.y,
          text: args.statement,
          position,
        };
      }

      case 'VotingFinalized': {
        if (typeof args.votingId !== 'bigint' || typeof args.success !== 'boolean') return undefined;
        return {
          kind: 'VOTING_FINALIZED',
          votingId: args.votingId,
          success: args.success,
          position,
        };
      }

      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
};
