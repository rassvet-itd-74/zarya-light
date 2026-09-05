import type { DatabaseSync } from 'node:sqlite';
import {
  DuplicateAttemptError,
  type LearnedFacts,
  type NewTransactionRecord,
  type SignerScope,
  type TransactionRecord,
  type TransactionStore,
  UnknownAttemptError,
} from '../../domain/ports/TransactionStore';
import { type ChainId, type EvmAddress, type OperationRef, chainId, evmAddress, operationRef } from '../../domain/primitives';
import {
  type TransactionState,
  assertTransactionTransition,
  isTransactionState,
} from '../../domain/transactions/transactionLifecycle';
import { inTransaction } from './database';

/**
 * The transaction store over `node:sqlite`.
 *
 * Same two properties as `SqliteOperationStore`, for the same reasons: the
 * primary key refuses a duplicate rather than an application `if`, and `advance`
 * reads and writes inside one transaction so the state machine's decision cannot
 * race another caller.
 *
 * One rule is specific to this table. **A transition and the facts it made true
 * are written together**, because each fact only becomes true at one edge — a
 * hash at `BROADCAST → PENDING`, an outcome at `PENDING → CONFIRMED`. Two writes
 * would allow a row holding a hash while still claiming it had not broadcast,
 * which is precisely the state recovery would misread.
 */
export class SqliteTransactionStore implements TransactionStore {
  constructor(private readonly db: DatabaseSync) {}

  async open(record: NewTransactionRecord): Promise<void> {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO transactions
             (attempt_id, operation_ref, chain_id, contract_address, signer_address,
              state, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.attemptId,
          record.operationRef,
          record.chainId as number,
          record.contractAddress.toLowerCase(),
          record.signerAddress.toLowerCase(),
          // Not a parameter: an attempt exists because a call was built, and
          // nothing has been signed. A row created in `BROADCAST` would claim
          // bytes had left.
          'READY' satisfies TransactionState,
          record.data,
          now,
          now,
        );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateAttemptError(record.attemptId);
      throw error;
    }
  }

  async find(attemptId: string): Promise<TransactionRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM transactions WHERE attempt_id = ?')
      .get(attemptId) as StoredRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  async advance(
    attemptId: string,
    state: TransactionState,
    learned: LearnedFacts = {},
  ): Promise<void> {
    inTransaction(this.db, () => {
      const row = this.db
        .prepare('SELECT state FROM transactions WHERE attempt_id = ?')
        .get(attemptId) as { state?: unknown } | undefined;
      if (row === undefined) throw new UnknownAttemptError(attemptId);

      const current = row.state;
      if (typeof current !== 'string' || !isTransactionState(current)) {
        throw new TypeError(`transaction ${attemptId} holds an unrecognised state`);
      }
      // Throws on an illegal move, inside the transaction, so a refusal leaves
      // the row exactly as it was.
      assertTransactionTransition(current, state);

      // `COALESCE` so a transition that learned nothing does not erase what an
      // earlier one recorded: a hash survives the move to `CONFIRMED`.
      this.db
        .prepare(
          `UPDATE transactions
              SET state = ?,
                  hash = COALESCE(?, hash),
                  nonce = COALESCE(?, nonce),
                  block_number = COALESCE(?, block_number),
                  confirmed_at = COALESCE(?, confirmed_at),
                  outcome = COALESCE(?, outcome),
                  failure = COALESCE(?, failure),
                  updated_at = ?
            WHERE attempt_id = ?`,
        )
        .run(
          state,
          learned.hash ?? null,
          learned.nonce ?? null,
          learned.blockNumber ?? null,
          learned.confirmedAt ?? null,
          learned.outcome ?? null,
          learned.failure ?? null,
          Date.now(),
          attemptId,
        );
    });
  }

  async listInFlight(scope: SignerScope): Promise<readonly TransactionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM transactions
          WHERE chain_id = ? AND contract_address = ? AND signer_address = ?
            AND state IN ('SIGNING', 'BROADCAST', 'PENDING')
          ORDER BY created_at ASC, attempt_id ASC`,
      )
      .all(...scopeArgs(scope));
    return rows.map((row) => rowToRecord(row));
  }

  async highestNonce(scope: SignerScope): Promise<number | undefined> {
    const row = this.db
      .prepare(
        `SELECT MAX(nonce) AS highest FROM transactions
          WHERE chain_id = ? AND contract_address = ? AND signer_address = ?`,
      )
      .get(...scopeArgs(scope)) as { highest?: unknown } | undefined;

    // `MAX` over no rows, or over rows that all have a null nonce, is null.
    return typeof row?.highest === 'number' ? row.highest : undefined;
  }
}

const scopeArgs = (scope: SignerScope): [number, string, string] => [
  scope.chainId as number,
  scope.contractAddress.toLowerCase(),
  scope.signerAddress.toLowerCase(),
];

type StoredRow = Readonly<Record<string, unknown>>;

/**
 * A row back into a record, validating every column.
 *
 * As strict as the operation store's, and for the same reason: `STRICT` stops a
 * column holding the wrong SQL type and says nothing about whether a `TEXT`
 * column holds a state this build knows. A row that fails here is a corrupted or
 * hand-edited database, and this is the layer that should say so.
 */
function rowToRecord(row: StoredRow): TransactionRecord {
  const attemptId = expectString(row.attempt_id, 'attempt_id');
  const state = expectString(row.state, 'state');
  if (!isTransactionState(state)) {
    throw new TypeError(`transaction ${attemptId} holds an unrecognised state`);
  }
  if (typeof row.chain_id !== 'number') {
    throw new TypeError(`transaction ${attemptId} has a non-numeric chain_id`);
  }
  if (typeof row.created_at !== 'number' || typeof row.updated_at !== 'number') {
    throw new TypeError(`transaction ${attemptId} has a non-numeric timestamp`);
  }
  if (row.nonce !== null && row.nonce !== undefined && typeof row.nonce !== 'number') {
    throw new TypeError(`transaction ${attemptId} has a non-numeric nonce`);
  }

  return {
    attemptId,
    operationRef: operationRef(expectString(row.operation_ref, 'operation_ref')) as OperationRef,
    chainId: chainId(row.chain_id) as ChainId,
    contractAddress: evmAddress(expectString(row.contract_address, 'contract_address')) as EvmAddress,
    signerAddress: evmAddress(expectString(row.signer_address, 'signer_address')) as EvmAddress,
    state,
    data: expectHex(row.data, attemptId, 'data'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.hash === null || row.hash === undefined
      ? {}
      : { hash: expectHex(row.hash, attemptId, 'hash') }),
    ...(typeof row.nonce === 'number' ? { nonce: row.nonce } : {}),
    ...optionalText(row.block_number, 'blockNumber'),
    ...(typeof row.confirmed_at === 'number' ? { confirmedAt: row.confirmed_at } : {}),
    ...optionalText(row.outcome, 'outcome'),
    ...optionalText(row.failure, 'failure'),
  };
}

const expectString = (value: unknown, column: string): string => {
  if (typeof value !== 'string') throw new TypeError(`column ${column} is not text`);
  return value;
};

/** Hex is checked rather than cast: this string becomes a call argument. */
const expectHex = (value: unknown, attemptId: string, column: string): `0x${string}` => {
  const text = expectString(value, column);
  if (!/^0x[0-9a-fA-F]*$/.test(text)) {
    throw new TypeError(`transaction ${attemptId} has a non-hex ${column}`);
  }
  return text as `0x${string}`;
};

const optionalText = (value: unknown, key: string): Record<string, string> => {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'string') throw new TypeError(`column ${key} is not text`);
  return { [key]: value };
};

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
