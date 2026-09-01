import type { ChainId, EvmAddress } from '../primitives';

/**
 * Where discovery left off.
 *
 * Declared now and implemented in memory, with the durable implementation
 * arriving in Phase 5 — the same shape as `Clock` in Phase 1, and for the same
 * reason: retrofitting a port after the call sites exist is the expensive
 * version. The in-memory adapter is honest about what it is; a client that
 * restarts backfills from the deployment block until Phase 5 lands.
 *
 * The cursor is a **cache, never authority**. Losing it costs a backfill and
 * nothing else, because the chain still holds every event. That is why an
 * in-memory implementation is a real option rather than a stub.
 */

/**
 * Cursors are scoped to a deployment. Carrying one across a chain or address
 * change would resume in the middle of a history that never happened, so the
 * key makes that impossible rather than leaving it to a convention.
 */
export interface CursorKey {
  readonly chainId: ChainId;
  readonly contractAddress: EvmAddress;
  /** Which projection. Discovery and the matrix index share a cursor's blocks, not its name. */
  readonly projection: string;
}

export const cursorKeyOf = (key: CursorKey): string =>
  `${key.chainId}:${key.contractAddress.toLowerCase()}:${key.projection}`;

export interface CursorStore {
  /** `undefined` means nothing has been projected yet — backfill from deployment. */
  read(key: CursorKey): Promise<bigint | undefined>;

  /**
   * Records that every block up to and including `blockNumber` is projected.
   *
   * Called **after** the window's records are handled, never before. An
   * implementation must reject a value below the stored one rather than
   * silently rewinding, since a rewind re-projects and a caller that meant it
   * should say so.
   */
  commit(key: CursorKey, blockNumber: bigint): Promise<void>;

  /** Deliberate rewind, for a reorg or a repair. Separate from {@link commit}. */
  rewind(key: CursorKey, blockNumber: bigint): Promise<void>;
}

export class CursorRewindError extends Error {
  constructor(readonly stored: bigint, readonly attempted: bigint) {
    super(
      `refusing to move the discovery cursor backwards from ${stored} to ${attempted} — ` +
        'use rewind() if that is intended',
    );
    this.name = 'CursorRewindError';
  }
}
