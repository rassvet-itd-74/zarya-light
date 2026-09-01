import {
  type CursorKey,
  CursorRewindError,
  type CursorStore,
  cursorKeyOf,
} from '../../domain/ports/CursorStore';

/**
 * The discovery cursor, held in memory until Phase 5 brings a database.
 *
 * Not a stub. The cursor is a cache over chain state, so losing it costs a
 * backfill from the deployment block and nothing else — no governance state is
 * kept here and none can be lost. That is exactly why an in-memory
 * implementation is a legitimate first one, and why it is safe to ship the
 * discovery path before persistence exists.
 *
 * What it does enforce is the monotonicity rule, because that rule belongs to
 * the port and not to whichever storage backs it: `commit` never moves
 * backwards, and a caller that means to rewind says so.
 */
export class MemoryCursorStore implements CursorStore {
  private readonly cursors = new Map<string, bigint>();

  async read(key: CursorKey): Promise<bigint | undefined> {
    return this.cursors.get(cursorKeyOf(key));
  }

  async commit(key: CursorKey, blockNumber: bigint): Promise<void> {
    if (blockNumber < 0n) {
      throw new RangeError(`a block number cannot be negative: ${blockNumber}`);
    }
    const id = cursorKeyOf(key);
    const stored = this.cursors.get(id);
    if (stored !== undefined && blockNumber < stored) {
      // Silently rewinding would re-project blocks the caller believes are
      // done, and silently ignoring would leave a gap. Neither is the store's
      // call to make.
      throw new CursorRewindError(stored, blockNumber);
    }
    this.cursors.set(id, blockNumber);
  }

  async rewind(key: CursorKey, blockNumber: bigint): Promise<void> {
    if (blockNumber < 0n) {
      throw new RangeError(`a block number cannot be negative: ${blockNumber}`);
    }
    this.cursors.set(cursorKeyOf(key), blockNumber);
  }

  /** Test and diagnostic access. Not part of the port. */
  get size(): number {
    return this.cursors.size;
  }
}
