/**
 * Deciding which blocks to scan next.
 *
 * Pure, and separated from the scanning itself, because every rule that keeps
 * discovery correct lives here: never rescan from the deployment on every poll,
 * never read blocks so fresh a reorg could take them back, and never ask a
 * provider for a range it will refuse.
 *
 * The cursor means **"every block up to and including this one has been
 * projected"**. It advances only after the records from a window have been
 * handled, so a crash mid-window re-scans rather than skips. Re-scanning is
 * safe: the projection is keyed by `votingId` and a repeated log overwrites an
 * identical entry.
 */

/**
 * How far behind the head to stay. Sepolia reorgs are shallow but real, and a
 * cursor advanced over a block that later disappears drops the votings created
 * in it — permanently, since nothing rescans behind the cursor.
 *
 * Twelve blocks is roughly two and a half minutes there. Discovery is not
 * latency-critical: a voting cannot need executing until its deadline passes,
 * and deadlines are hours or days out.
 */
export const DEFAULT_CONFIRMATIONS = 12n;

/**
 * Provider ceiling on a single `eth_getLogs` range. Public endpoints commonly
 * refuse wider spans, and a refusal in the middle of a backfill is worse than
 * several accepted requests.
 */
export const DEFAULT_MAX_BLOCKS_PER_SCAN = 5_000n;

export interface DiscoveryInputs {
  /** Highest block already projected, or `undefined` on a fresh client. */
  readonly cursor: bigint | undefined;
  readonly headBlock: bigint;
  /** Nothing before this exists to find. */
  readonly deploymentBlock: bigint;
  readonly confirmations?: bigint;
  readonly maxBlocksPerScan?: bigint;
}

export type DiscoveryPlan =
  | { readonly kind: 'SCAN'; readonly fromBlock: bigint; readonly toBlock: bigint }
  /**
   * Nothing to do: the cursor already covers everything confirmed. Distinct from
   * an error — a quiet chain is the normal case between polls.
   */
  | { readonly kind: 'UP_TO_DATE' }
  /**
   * The cursor is ahead of the confirmed head. A reorg, a provider serving a
   * stale head, or a cursor carried across a chain change. Never silently
   * rewound: the caller decides, because rewinding re-projects and moving
   * forward hides a gap.
   */
  | { readonly kind: 'CURSOR_AHEAD'; readonly cursor: bigint; readonly confirmedHead: bigint };

export function planDiscovery({
  cursor,
  headBlock,
  deploymentBlock,
  confirmations = DEFAULT_CONFIRMATIONS,
  maxBlocksPerScan = DEFAULT_MAX_BLOCKS_PER_SCAN,
}: DiscoveryInputs): DiscoveryPlan {
  if (maxBlocksPerScan <= 0n) {
    throw new RangeError('maxBlocksPerScan must be positive');
  }

  // Saturating rather than wrapping: on a fresh devnet the head can be below
  // the confirmation depth, and a negative block number is not a thing.
  const confirmedHead = headBlock >= confirmations ? headBlock - confirmations : -1n;
  if (confirmedHead < deploymentBlock) return { kind: 'UP_TO_DATE' };

  const fromBlock = cursor === undefined ? deploymentBlock : cursor + 1n;

  if (cursor !== undefined && cursor > confirmedHead) {
    return { kind: 'CURSOR_AHEAD', cursor, confirmedHead };
  }
  if (fromBlock > confirmedHead) return { kind: 'UP_TO_DATE' };

  // Inclusive on both ends, matching eth_getLogs.
  const span = confirmedHead - fromBlock + 1n;
  const toBlock = span > maxBlocksPerScan ? fromBlock + maxBlocksPerScan - 1n : confirmedHead;

  return { kind: 'SCAN', fromBlock, toBlock };
}

/**
 * Whether a backfill still has ground to cover after this window — so a caller
 * can keep scanning to catch up rather than waiting a poll interval per chunk.
 */
export const hasMoreToScan = (plan: DiscoveryPlan, inputs: DiscoveryInputs): boolean => {
  if (plan.kind !== 'SCAN') return false;
  return planDiscovery({ ...inputs, cursor: plan.toBlock }).kind === 'SCAN';
};
