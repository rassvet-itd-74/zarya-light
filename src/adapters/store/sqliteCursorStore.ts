import type { DatabaseSync } from 'node:sqlite';
import {
  type CursorKey,
  CursorRewindError,
  type CursorStore,
} from '../../domain/ports/CursorStore';
import { inTransaction } from './database';

/**
 * The durable discovery cursor, replacing `MemoryCursorStore`.
 *
 * The in-memory one was honest and not a stub — losing a cursor costs a
 * backfill and nothing else, because the chain still holds every event. What
 * changes here is the cost of a restart, not correctness: `VotingCreated` is the
 * only source of a voting's `endTime`, so a client that backfills from the
 * deployment block on every launch spends real time re-deriving deadlines it
 * already knew.
 *
 * `MemoryCursorStore` stays. It is the right implementation for a test that
 * does not want a file, and the two are held to the same rule by one shared
 * suite — which is the point of the port.
 *
 * ## Block numbers are stored as text
 *
 * `node:sqlite` returns an INTEGER column as a JavaScript `number`, and every
 * block number in this client is a `bigint`. Storing 11 553 464 as a number
 * works; storing something past 2^53 silently does not. Text is exact and
 * nothing does arithmetic on the column in SQL.
 */
export class SqliteCursorStore implements CursorStore {
  constructor(private readonly db: DatabaseSync) {}

  async read(key: CursorKey): Promise<bigint | undefined> {
    const row = this.db
      .prepare(
        `SELECT block_number FROM cursors
          WHERE chain_id = ? AND contract_address = ? AND projection = ?`,
      )
      .get(key.chainId as number, key.contractAddress.toLowerCase(), key.projection) as
      | { block_number?: unknown }
      | undefined;
    if (row === undefined) return undefined;
    if (typeof row.block_number !== 'string') {
      throw new TypeError(`cursor ${key.projection} holds a non-text block number`);
    }
    return BigInt(row.block_number);
  }

  /**
   * The monotonicity rule belongs to the port, so it is enforced identically
   * here and in memory: `commit` never moves backwards, and a caller that means
   * to rewind says so.
   *
   * Read and write are one transaction. Two windows committing concurrently
   * could otherwise both read the old value and the lower one could win — which
   * would leave the cursor claiming blocks are projected that are not, and a gap
   * in a projection is invisible until a deadline is missing.
   */
  async commit(key: CursorKey, blockNumber: bigint): Promise<void> {
    assertNonNegative(blockNumber);
    inTransaction(this.db, () => {
      const stored = this.readSync(key);
      if (stored !== undefined && blockNumber < stored) {
        throw new CursorRewindError(stored, blockNumber);
      }
      this.write(key, blockNumber);
    });
  }

  async rewind(key: CursorKey, blockNumber: bigint): Promise<void> {
    assertNonNegative(blockNumber);
    this.write(key, blockNumber);
  }

  private readSync(key: CursorKey): bigint | undefined {
    const row = this.db
      .prepare(
        `SELECT block_number FROM cursors
          WHERE chain_id = ? AND contract_address = ? AND projection = ?`,
      )
      .get(key.chainId as number, key.contractAddress.toLowerCase(), key.projection) as
      | { block_number?: unknown }
      | undefined;
    return typeof row?.block_number === 'string' ? BigInt(row.block_number) : undefined;
  }

  private write(key: CursorKey, blockNumber: bigint): void {
    this.db
      .prepare(
        `INSERT INTO cursors (chain_id, contract_address, projection, block_number)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (chain_id, contract_address, projection)
           DO UPDATE SET block_number = excluded.block_number`,
      )
      .run(
        key.chainId as number,
        key.contractAddress.toLowerCase(),
        key.projection,
        blockNumber.toString(),
      );
  }
}

function assertNonNegative(blockNumber: bigint): void {
  if (blockNumber < 0n) throw new RangeError(`a block number cannot be negative: ${blockNumber}`);
}
