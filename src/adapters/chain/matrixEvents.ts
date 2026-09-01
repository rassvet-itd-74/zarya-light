import { type Abi, type AbiEvent, toEventSelector } from 'viem';
import { type MatrixCoordinate, matrixCoordinate } from '../../domain/matrix/matrix';
import { type EvmAddress, evmAddress } from '../../domain/primitives';
import type { ZaryaPublicClient } from './publicClient';
import { AbiContractError, ZARYA_ABI, requireEvent } from './zaryaAbi';

/**
 * The two events that record a matrix change **as applied**, and the one
 * hand-written ABI fragment in this client.
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

export const MATRIX_EVENT_ABI: Abi = [VALUE_ADDED_EVENT, CATEGORY_ADDED_EVENT];

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
 * A matrix change that has already been applied.
 *
 * Only applied changes appear here. `ValueAdded` and `CategoryAdded` fire from
 * inside `_executeApprovedSuggestion`, so their presence *is* the evidence that a
 * voting passed and its mutation landed — no gating on `VotingFinalized` needed.
 * Decimals, themes and statements emit nothing at all and must be projected from
 * creation events gated on finalization instead; that is the matrix report's
 * problem (Phase 4), not this module's.
 */
export type MatrixChange =
  | {
      readonly kind: 'VALUE_ADDED';
      readonly at: MatrixCoordinate;
      readonly value: bigint;
      readonly author: EvmAddress;
      readonly blockNumber: bigint;
      /**
       * Absent by construction. `ValueAdded` carries no `isCategorical`, so which
       * matrix this landed in is decided by reading the cells at `at` and
       * applying `attributeValue` — never by this record.
       */
    }
  | {
      readonly kind: 'CATEGORY_ADDED';
      readonly at: MatrixCoordinate;
      readonly category: bigint;
      readonly blockNumber: bigint;
    };

export interface ScannedMatrixWindow {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly changes: readonly MatrixChange[];
}

/**
 * Scans one block window for applied matrix changes.
 *
 * Deliberately not a projection: it takes the window it is given and reports what
 * is in it, exactly as `ZaryaVotingDiscovery.scan` does, so both consume the one
 * cursor `planDiscovery` advances rather than sweeping independently.
 */
export class ZaryaMatrixEvents {
  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
  ) {}

  async scan(fromBlock: bigint, toBlock: bigint): Promise<ScannedMatrixWindow> {
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

    const changes: MatrixChange[] = [];
    for (const log of logs) {
      const change = toChange(log as DecodedMatrixLog);
      if (change !== undefined) changes.push(change);
    }
    return { fromBlock, toBlock, changes };
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
}

const toChange = (log: DecodedMatrixLog): MatrixChange | undefined => {
  const { blockNumber } = log;
  if (blockNumber === null || blockNumber === undefined) return undefined;

  const args = log.args as
    | { x?: unknown; y?: unknown; value?: unknown; author?: unknown; category?: unknown }
    | undefined;
  if (typeof args?.x !== 'bigint' || typeof args.y !== 'bigint') return undefined;

  try {
    const at = matrixCoordinate(args.x, args.y);
    if (log.eventName === 'ValueAdded') {
      if (typeof args.value !== 'bigint' || typeof args.author !== 'string') return undefined;
      return {
        kind: 'VALUE_ADDED',
        at,
        value: args.value,
        author: evmAddress(args.author),
        blockNumber,
      };
    }
    if (log.eventName === 'CategoryAdded') {
      if (typeof args.category !== 'bigint') return undefined;
      return { kind: 'CATEGORY_ADDED', at, category: args.category, blockNumber };
    }
    return undefined;
  } catch {
    // Dropped rather than projected as a partial change: an absent coordinate
    // reads as "not yet indexed", a wrong one reads as a fact.
    return undefined;
  }
};
