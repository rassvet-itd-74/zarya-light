import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations';

/**
 * Opening the local database, and running migrations to reach the current
 * schema.
 *
 * ## Why `node:sqlite`
 *
 * Probed rather than assumed. **Electron 43.4.1 bundles Node 24.18.1**, and
 * `node:sqlite` works there — a `DatabaseSync(':memory:')`, a `CREATE TABLE`,
 * and a read-back, run inside a real Electron main process.
 *
 * That matters because the alternative was `better-sqlite3`, whose cost is a
 * native module: it needs an ABI rebuild against Electron's Node, a second
 * build for the Node that runs the tests, and `plugin-auto-unpack-natives` in
 * the packaged app. Two builds of a C++ dependency is exactly the sort of thing
 * that works on one machine and fails in CI. `node:sqlite` is in the runtime
 * already, so there is nothing to compile, nothing to unpack, and the API is
 * identical in tests and in production.
 *
 * The cost is that it is **experimental**: Node 22 emits an `ExperimentalWarning`
 * for it, and the API may change. Two things keep that bounded — only
 * `DatabaseSync`, `exec` and `prepare`/`get`/`all`/`run` are used, which is the
 * part any SQLite binding has; and the whole surface is behind two ports, so a
 * swap is two files rather than a search for query strings.
 *
 * ## The version skew is real and worth stating
 *
 * Tests run on the Node that runs `vitest` — 22.14 here — and production runs on
 * Electron's Node 24.18. The same module name in two runtimes is not the same
 * guarantee as the same module. It is still strictly better than
 * `better-sqlite3`, where the two runtimes need two separately compiled
 * binaries; here they need none.
 *
 * ## Single writer
 *
 * The worker owns this database and the main process never opens it.
 * `ARCHITECTURE.md` already puts the transaction queue, reconciliation, and form
 * work in the worker, and giving main a second handle would mean two processes
 * writing one file — which SQLite can do, and which nothing here needs. Status
 * for the UI travels over the worker protocol, not over a second connection.
 */

export interface DatabaseHandle {
  readonly db: DatabaseSync;
  /** The schema version actually present after opening. */
  readonly version: number;
  close(): void;
}

/**
 * Pragmas, and why each one.
 *
 * - `journal_mode = WAL` — a crash mid-write leaves a recoverable database
 *   rather than a truncated one, which is the whole reason this file exists:
 *   `INVARIANTS.md` treats local state as a durable job cache that has to
 *   survive a kill.
 * - `synchronous = FULL` — the default `NORMAL` can lose the last transactions
 *   on an OS crash. An `operationRef` written and then lost is a form emitted
 *   against no record, which is the one ordering this store exists to guarantee.
 * - `foreign_keys = ON` — off by default in SQLite, so a declared reference is
 *   decoration until this is set.
 * - `busy_timeout` — small, because there is one writer; it covers a checkpoint
 *   rather than contention.
 */
const PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = FULL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
];

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `this database is at schema version ${found} and this build supports ${supported} — ` +
        'it was written by a newer version of the application. Refusing to open it rather than ' +
        'migrating downwards.',
    );
    this.name = 'SchemaTooNewError';
  }
}

/**
 * Opens `path` and migrates it forward.
 *
 * `:memory:` is a legitimate path and is what the tests use, which keeps the
 * migration runner on the same code path in both.
 */
export function openDatabase(path: string): DatabaseHandle {
  const db = new DatabaseSync(path);
  for (const pragma of PRAGMAS) db.exec(pragma);

  const version = migrate(db);
  return {
    db,
    version,
    close: () => db.close(),
  };
}

/**
 * Applies every migration above the stored version, in order.
 *
 * `PRAGMA user_version` rather than a table of applied migrations: it is a
 * single integer SQLite maintains itself, it cannot disagree with the schema it
 * describes, and there is no bootstrapping problem where the migrations table
 * needs a migration.
 *
 * Each migration runs inside a transaction with the version bump, so a failure
 * part-way leaves the database at the previous version rather than half
 * migrated. `user_version` cannot be parameterised, which is why it is
 * interpolated — the value is a number from a literal list in this repository,
 * never input.
 */
export function migrate(db: DatabaseSync): number {
  const stored = currentVersion(db);
  if (stored > SCHEMA_VERSION) throw new SchemaTooNewError(stored, SCHEMA_VERSION);

  for (const migration of MIGRATIONS) {
    if (migration.version <= stored) continue;
    db.exec('BEGIN');
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `migration to schema version ${migration.version} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  return currentVersion(db);
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Runs `work` inside a transaction, rolling back if it throws.
 *
 * Synchronous on purpose. `zarya-persistence`: never hold a database
 * transaction open across an RPC call — a signature that cannot accept a promise
 * makes that impossible rather than discouraged.
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
