/**
 * The schema, as an append-only list of migrations.
 *
 * `zarya-persistence`: use migrations, and never mutate schema implicitly at
 * runtime without versioning. So this list is **append-only** — an existing
 * entry is never edited, because a database in the field has already run it and
 * editing it would mean two installations at "version 1" with different tables.
 * A change to an existing table is a new entry.
 */

export interface Migration {
  readonly version: number;
  /** Executed in order, inside one transaction with the version bump. */
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      /**
       * The issued-template record: the trust anchor ingestion resolves an
       * `operationRef` against.
       *
       * `operation_ref` is the primary key, so a duplicate is refused by the
       * engine rather than by an application check — the uniqueness is
       * race-sensitive and an `if` around it is not a constraint.
       *
       * The two JSON columns are opaque to the domain by design (see
       * `OperationStore`). They are stored as text rather than shredded into
       * rows because nothing queries inside them: they are read whole, by
       * `operation_ref`, and a schema for their keys would be the form schema
       * duplicated in SQL.
       *
       * `recorded_at` is wall-clock milliseconds and is audit only. Nothing
       * reads it to make a decision; chain time is the only clock this client
       * reasons with.
       */
      `CREATE TABLE operations (
         operation_ref     TEXT    PRIMARY KEY NOT NULL,
         operation_type    TEXT    NOT NULL,
         chain_id          INTEGER NOT NULL,
         contract_address  TEXT    NOT NULL,
         state             TEXT    NOT NULL,
         bound_values      TEXT    NOT NULL,
         displayed_context TEXT    NOT NULL,
         recorded_at       INTEGER NOT NULL
       ) STRICT`,

      // Reconciliation asks "what was in flight on this deployment", which is
      // the only query that is not by primary key.
      `CREATE INDEX operations_by_scope_state
         ON operations (chain_id, contract_address, state, recorded_at)`,

      /**
       * The discovery cursor.
       *
       * `block_number` is TEXT, not INTEGER, and deliberately: `node:sqlite`
       * hands an INTEGER column back as a JavaScript `number`, and every block
       * number in this client is a `bigint`. Round-tripping through `number`
       * works for Sepolia's eleven million and stops working silently somewhere
       * past 2^53 — a bug with no symptom until it has one. Text is exact, and
       * nothing does arithmetic on this column in SQL.
       *
       * The primary key is the same triple `cursorKeyOf` composes, kept as three
       * columns so a deployment's cursors can be deleted or listed without
       * string matching.
       */
      `CREATE TABLE cursors (
         chain_id         INTEGER NOT NULL,
         contract_address TEXT    NOT NULL,
         projection       TEXT    NOT NULL,
         block_number     TEXT    NOT NULL,
         PRIMARY KEY (chain_id, contract_address, projection)
       ) STRICT`,
    ],
  },
];

/** The version a fresh database is migrated to. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
