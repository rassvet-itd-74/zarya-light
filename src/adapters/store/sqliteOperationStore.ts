import type { DatabaseSync } from 'node:sqlite';
import { type OperationType, isOperationType } from '../../domain/intents/intent';
import {
  type IssuedTemplateState,
  assertTransition,
  isIssuedTemplateState,
} from '../../domain/operations/issuedTemplate';
import {
  DuplicateOperationRefError,
  type NewOperationRecord,
  type OperationRecord,
  type OperationStore,
  UnknownOperationRefError,
} from '../../domain/ports/OperationStore';
import {
  type ChainId,
  type EvmAddress,
  type OperationRef,
  chainId,
  evmAddress,
  operationRef,
} from '../../domain/primitives';
import { inTransaction } from './database';

/**
 * The operation store over `node:sqlite`.
 *
 * Two things here are not incidental.
 *
 * **Uniqueness is the engine's, not an `if`'s.** `record` inserts and lets the
 * primary key refuse a duplicate, because checking-then-inserting is a race and
 * `zarya-persistence` says not to rely on an application check for
 * race-sensitive uniqueness. The engine's error is translated into a domain
 * error so callers never match on a SQLite message.
 *
 * **`advance` reads and writes in one transaction.** The state machine's
 * decision depends on the current state, so reading it in one statement and
 * writing in another would let two callers both see `RECORDED` and both move on.
 * The check and the write are atomic, and the transaction is synchronous so it
 * cannot span an RPC call.
 *
 * Rows are re-validated on the way out — `isOperationType`, `isIssuedTemplateState`,
 * `evmAddress` — rather than cast. A database is a file on a disk a user owns; it
 * can be edited, restored from an old backup, or corrupted, and a row read back
 * unchecked is untrusted input with a `TEXT` column in front of it.
 */
export class SqliteOperationStore implements OperationStore {
  constructor(private readonly db: DatabaseSync) {}

  async record(record: NewOperationRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO operations
             (operation_ref, operation_type, chain_id, contract_address,
              state, bound_values, displayed_context, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.operationRef,
          record.operationType,
          record.chainId as number,
          // Lower-cased on the way in so a lookup cannot miss on checksum
          // casing. The checksummed form is recoverable from the address itself.
          record.contractAddress.toLowerCase(),
          // Not a parameter of the call: an operation exists because the
          // application decided to issue a template and had everything it
          // needed. Creating one in `EMITTED` would claim a file was handed over.
          'RECORDED' satisfies IssuedTemplateState,
          JSON.stringify(record.boundValues),
          JSON.stringify(record.displayedContext),
          Date.now(),
        );
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateOperationRefError(record.operationRef);
      throw error;
    }
  }

  async find(ref: OperationRef): Promise<OperationRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM operations WHERE operation_ref = ?')
      .get(ref) as StoredRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  async advance(ref: OperationRef, state: IssuedTemplateState): Promise<void> {
    inTransaction(this.db, () => {
      const row = this.db
        .prepare('SELECT state FROM operations WHERE operation_ref = ?')
        .get(ref) as { state?: unknown } | undefined;
      if (row === undefined) throw new UnknownOperationRefError(ref);

      const current = row.state;
      if (typeof current !== 'string' || !isIssuedTemplateState(current)) {
        throw new TypeError(`operation ${ref} holds an unrecognised state`);
      }
      // Throws on an illegal move. Inside the transaction, so a refusal leaves
      // the row exactly as it was.
      assertTransition(current, state);

      this.db.prepare('UPDATE operations SET state = ? WHERE operation_ref = ?').run(state, ref);
    });
  }

  async listByState(
    scope: { readonly chainId: ChainId; readonly contractAddress: EvmAddress },
    state: IssuedTemplateState,
  ): Promise<readonly OperationRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM operations
          WHERE chain_id = ? AND contract_address = ? AND state = ?
          ORDER BY recorded_at ASC, operation_ref ASC`,
      )
      .all(scope.chainId as number, scope.contractAddress.toLowerCase(), state);
    return rows.map((row) => rowToRecord(row));
  }
}

/**
 * A row as the driver hands it over.
 *
 * Not a named interface per column: `node:sqlite` types a result as
 * `Record<string, SQLOutputValue>`, and declaring a stricter shape only to cast
 * to it would assert the very thing {@link rowToRecord} exists to check. Every
 * column is validated on the way out, so `unknown` is the honest input type.
 */
type StoredRow = Readonly<Record<string, unknown>>;

/**
 * A row back into a record, validating every column.
 *
 * Deliberately strict. `STRICT` tables stop a column holding the wrong SQL
 * *type*, and say nothing about whether a `TEXT` column holds an operation type
 * this build knows or an address that parses. A row that fails here is a
 * corrupted or hand-edited database, and reporting that is far better than
 * handing a malformed organ into a transaction.
 */
function rowToRecord(row: StoredRow): OperationRecord {
  const ref = expectString(row.operation_ref, 'operation_ref');
  const type = expectString(row.operation_type, 'operation_type');
  if (!isOperationType(type)) {
    throw new TypeError(`operation ${ref} names an unknown operation type`);
  }
  if (typeof row.chain_id !== 'number') {
    throw new TypeError(`operation ${ref} has a non-numeric chain_id`);
  }
  const state = expectString(row.state, 'state');
  if (!isIssuedTemplateState(state)) {
    throw new TypeError(`operation ${ref} holds an unrecognised state`);
  }
  if (typeof row.recorded_at !== 'number') {
    throw new TypeError(`operation ${ref} has a non-numeric recorded_at`);
  }

  return {
    operationRef: operationRef(ref),
    operationType: type satisfies OperationType,
    chainId: chainId(row.chain_id),
    contractAddress: evmAddress(expectString(row.contract_address, 'contract_address')),
    state,
    boundValues: parseStringMap(row.bound_values, ref, 'bound_values'),
    displayedContext: parseStringMap(row.displayed_context, ref, 'displayed_context'),
    recordedAt: row.recorded_at,
  };
}

const expectString = (value: unknown, column: string): string => {
  if (typeof value !== 'string') throw new TypeError(`column ${column} is not text`);
  return value;
};

/**
 * A JSON column back into a flat map of strings.
 *
 * Every value is checked to be a string rather than trusted, because these maps
 * flow into the intent builder, which reads them as raw form text. A nested
 * object or a number arriving where a string belongs would reach validation as
 * something it has no case for.
 */
function parseStringMap(
  value: unknown,
  ref: string,
  column: string,
): Readonly<Record<string, string>> {
  const text = expectString(value, column);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`operation ${ref} has unreadable ${column}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`operation ${ref} has a non-object ${column}`);
  }
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'string') {
      throw new TypeError(`operation ${ref} has a non-text value in ${column}`);
    }
    map[key] = entry;
  }
  return map;
}

/**
 * Whether a thrown error is the primary-key violation.
 *
 * Matched on the message because `node:sqlite` surfaces constraint failures as a
 * plain `Error` without a stable code — the same shape of problem pdf-lib's
 * `EncryptedPDFError` had. It is narrow rather than a bare `catch`: any other
 * failure is rethrown, so a disk error is never reported as a duplicate
 * reference.
 */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(error.message);
