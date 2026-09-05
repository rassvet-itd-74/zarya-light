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
  {
    version: 2,
    statements: [
      /**
       * What a returned form turned out to be, written when it is imported.
       *
       * All nullable, and that is the schema saying something true: an operation
       * that has only been issued has no returned form, and a row from version 1
       * never will. A `NOT NULL DEFAULT ''` would make "never imported" and
       * "imported with an empty identity" the same value.
       *
       * `identity_key` is the canonical string from `operationIdentity.ts`, not
       * a digest. It has to be stable and distinct; a string already is, and it
       * can be read in a database where a hash would have to be recomputed to
       * mean anything.
       *
       * `vote_direction` is stored **beside** the identity rather than inside
       * it, because `FOR` and `AGAINST` on one voting share an identity on
       * purpose — that collision is what surfaces a contradiction instead of
       * submitting both.
       */
      `ALTER TABLE operations ADD COLUMN identity_key TEXT`,
      `ALTER TABLE operations ADD COLUMN vote_direction TEXT`,

      /**
       * The returned file itself, and its digest.
       *
       * `zarya-persistence`: receipts are regenerated, not recovered — keep the
       * returned form's bytes so a lost receipt can be re-stamped without a
       * chain write. Phase 6 is what reads this; it is stored now because the
       * bytes only exist at import and cannot be recovered afterwards.
       *
       * The digest is of the file as received, so a second copy can be
       * recognised as byte-identical rather than merely equivalent.
       */
      `ALTER TABLE operations ADD COLUMN form_hash TEXT`,
      `ALTER TABLE operations ADD COLUMN form_bytes BLOB`,

      // Dedup asks "has this deployment already seen this operation", which is
      // the second query that is not by primary key.
      `CREATE INDEX operations_by_identity
         ON operations (chain_id, contract_address, identity_key)`,
    ],
  },
  {
    version: 3,
    statements: [
      /**
       * Every write this client has attempted.
       *
       * The table exists for **recovery** rather than audit. After a crash the
       * only thing saying a transaction may be sitting in a mempool is a row
       * here, and the only way to find out is the nonce it assigned.
       *
       * `attempt_id` is the key and not `operation_ref`, because one operation
       * can have several attempts: a reverted transaction still consumed a nonce
       * and still happened, so resubmitting is a new row rather than a rewind of
       * the old one.
       *
       * `nonce` is INTEGER — it is genuinely small and is compared numerically
       * against the provider's — while `block_number` is TEXT for the reason the
       * cursor is: block heights are bigint, and `node:sqlite` hands an INTEGER
       * column back as a `number`.
       *
       * `hash` and `nonce` are nullable because the gap between them is the
       * crash window that matters: a row with a nonce and no hash is
       * recoverable, and a row with neither was never sent.
       *
       * **No raw signed payload column, deliberately.** A persisted signed
       * transaction is a bearer instrument in a file a backup copies; see
       * `Signer`.
       */
      `CREATE TABLE transactions (
         attempt_id       TEXT    PRIMARY KEY NOT NULL,
         operation_ref    TEXT    NOT NULL,
         chain_id         INTEGER NOT NULL,
         contract_address TEXT    NOT NULL,
         signer_address   TEXT    NOT NULL,
         state            TEXT    NOT NULL,
         data             TEXT    NOT NULL,
         hash             TEXT,
         nonce            INTEGER,
         block_number     TEXT,
         confirmed_at     INTEGER,
         outcome          TEXT,
         failure          TEXT,
         created_at       INTEGER NOT NULL,
         updated_at       INTEGER NOT NULL,
         FOREIGN KEY (operation_ref) REFERENCES operations (operation_ref)
       ) STRICT`,

      // The startup question: what could a crash have left mid-flight for this
      // wallet on this deployment. A nonce means nothing without both.
      `CREATE INDEX transactions_in_flight
         ON transactions (chain_id, contract_address, signer_address, state, created_at)`,

      // And the nonce ceiling, asked of the same scope.
      `CREATE INDEX transactions_by_nonce
         ON transactions (chain_id, contract_address, signer_address, nonce)`,
    ],
  },
];

/** The version a fresh database is migrated to. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
