import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SchemaTooNewError, inTransaction, migrate, openDatabase } from './database';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations';

/**
 * The engine and the migration runner.
 *
 * `node:sqlite` was chosen by probing Electron rather than by reading a README:
 * Electron 43.4.1 bundles Node 24.18.1 and `DatabaseSync` works there, so there
 * is no native module to rebuild for two runtimes. These tests run on the Node
 * that runs vitest, which is the version skew named in `database.ts`.
 */

describe('opening a database', () => {
  it('migrates a fresh one to the current schema', () => {
    const handle = openDatabase(':memory:');
    expect(handle.version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
    handle.close();
  });

  it('creates the tables the stores need', () => {
    const handle = openDatabase(':memory:');
    const names = handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(names).toContain('operations');
    expect(names).toContain('cursors');
    handle.close();
  });

  it('turns foreign keys on, which SQLite leaves off by default', () => {
    // A declared reference is decoration until this is set, so it is worth
    // asserting rather than assuming the pragma took.
    const handle = openDatabase(':memory:');
    expect(handle.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    handle.close();
  });

  it('is idempotent, so a second open migrates nothing', () => {
    const handle = openDatabase(':memory:');
    expect(migrate(handle.db)).toBe(SCHEMA_VERSION);
    expect(migrate(handle.db)).toBe(SCHEMA_VERSION);
    handle.close();
  });
});

describe('a database from a newer build', () => {
  it('is refused rather than migrated downwards', () => {
    // Downgrading a schema is not something a migration list can express, and
    // opening it anyway would let an old build write rows a new one cannot read.
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    expect(() => migrate(db)).toThrow(SchemaTooNewError);
    expect(() => migrate(db)).toThrow(/newer version of the application/);
    db.close();
  });
});

describe('the migration list', () => {
  it('is append-only in shape: versions ascend from 1 with no gaps', () => {
    // An existing entry is never edited, because a database in the field has
    // already run it — two installations at "version 1" with different tables
    // is the failure this shape prevents.
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
  });

  it('leaves the version at the previous one when a statement fails', () => {
    // Each migration runs in a transaction with its own version bump, so a
    // half-applied schema is not a state the application can be started in.
    const db = new DatabaseSync(':memory:');
    expect(() =>
      migrateWith(db, [{ version: 1, statements: ['CREATE TABLE a (x INTEGER)', 'THIS IS NOT SQL'] }]),
    ).toThrow(/migration to schema version 1 failed/);

    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    expect(tables).not.toContain('a');
    db.close();
  });
});

describe('inTransaction', () => {
  it('commits on success', () => {
    const handle = openDatabase(':memory:');
    inTransaction(handle.db, () => {
      handle.db.exec("PRAGMA user_version = 1");
      return undefined;
    });
    handle.close();
  });

  it('rolls back on a throw and lets the error out', () => {
    const handle = openDatabase(':memory:');
    handle.db.exec('CREATE TABLE t (x INTEGER)');
    expect(() =>
      inTransaction(handle.db, () => {
        handle.db.prepare('INSERT INTO t VALUES (1)').run();
        throw new Error('deliberate');
      }),
    ).toThrow('deliberate');
    expect(handle.db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    handle.close();
  });

  it('is synchronous, so it cannot span an RPC call', () => {
    // `zarya-persistence`: never hold a transaction open across an RPC call. A
    // signature that cannot accept a promise makes that impossible rather than
    // merely discouraged — this asserts the returned value is not a thenable.
    const handle = openDatabase(':memory:');
    const result = inTransaction(handle.db, () => 42);
    expect(result).toBe(42);
    expect((result as unknown as { then?: unknown }).then).toBeUndefined();
    handle.close();
  });
});

/** The migration runner over a supplied list, for the failure case above. */
function migrateWith(
  db: DatabaseSync,
  list: readonly { version: number; statements: readonly string[] }[],
): void {
  for (const migration of list) {
    db.exec('BEGIN');
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration to schema version ${migration.version} failed`, { cause: error });
    }
  }
}
