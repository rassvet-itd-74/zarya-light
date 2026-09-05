# Phase 5 slice 2 — semantic operation identity and the stored returned form

## Ask

*"Proceed according to the plan"* — Phase 5, at pace. The plan I stated and worked to: build only the
two items that have a caller today, both driven by the import that landed earlier, and leave the
tables whose writers live in Phases 6–8 unbuilt.

## Changes

**`domain/intents/operationIdentity.ts`** — `canonicalIdentity(intent, scope)` and
`voteDirectionOf(intent)`.

- A **string**, not a digest: the domain may not import `node:crypto` (hard rule 9), and a key only
  has to be stable and distinct. A string also means something when read in a database.
- Components are **length-prefixed**, because `["ab","c"]` and `["a","bc"]` must not collide and any
  separator chosen to be improbable is a bug waiting for a governance statement containing it.
- **A vote's direction is excluded**, so `FOR` and `AGAINST` on one voting share a key. The collision
  is the feature — it is what lets the application say two forms contradict instead of submitting
  both. The direction is stored beside the key.
- **The signer is absent.** `zarya-intents` names it; there is no `Signer` port until Phase 6, and
  hard rule 8 is one wallet per installation, so within a database it is a constant that
  distinguishes nothing.
- A numerical value carries **both** its integer and its scale: `1234` at two decimals and `12340` at
  three are the same quantity.

**Schema v2** — `identity_key`, `vote_direction`, `form_hash`, `form_bytes` on `operations`, plus an
index on `(chain_id, contract_address, identity_key)`. All nullable, deliberately: an operation only
ever issued has no returned form, and a `NOT NULL DEFAULT ''` would make "never imported" and
"imported with an empty identity" the same value. `ALTER TABLE`, so existing rows keep their context.

**`OperationStore` gains `findByIdentity` and `recordReturn`.** `recordReturn` writes the identity,
the direction, the digest and the bytes **and** moves the state, in one transaction. Two calls would
leave two crash windows meaning opposite things: a `RETURNED` row with no bytes cannot regenerate its
receipt in Phase 6, and an `EMITTED` row holding an identity would dedup against itself. The digest
is computed inside the adapter, so no caller can store a hash that does not describe the bytes next
to it.

**`importReturnedForm`** derives the identity from the **built intent**, not from the form — so two
documents filled differently that mean the same thing collide, and a form that failed validation
never reserves an identity. A match under a different `operationRef` is `DUPLICATE_OPERATION`, or
`CONFLICTING_VOTE` when the stored direction is the opposite one.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test
typecheck=0 lint=0 test=0

 Test Files  71 passed (71)
      Tests  961 passed (961)      # was 950
```

Eleven new tests. The two that carry the argument:

- **`surfaces two opposite votes on one voting as a conflict, not a duplicate`** — three real
  `CAST_VOTE` templates through the real issuer into one SQLite database. `FOR` imports, `AGAINST`
  is refused as `CONFLICTING_VOTE`, and a second `FOR` is refused as `DUPLICATE_OPERATION`. That
  those are different answers is the whole reason direction sits beside the key rather than in it.
- **`carries an existing database forward without losing its rows`** — a version 1 database built
  from `MIGRATIONS[0]` itself, with a row in it, opened and upgraded. The row keeps its state and the
  new column reads `null`. This is the path that matters in the field, since the real database at
  `%APPDATA%/zarya-light/zarya.db` already holds issued operations at version 1, and a migration that
  recreated the table would have passed every other test here while detaching every emitted form from
  its context.

## Unverified

- **Nothing was run.** The app was not launched and no button pressed after this slice. The import
  button remains unclicked from two entries ago, and the upgrade of the *real* database at
  `%APPDATA%` has not happened — only a reconstruction of it in a temp file.
- **`form_bytes` has no reader.** Phase 6 regenerates receipts from it. It is written now because the
  bytes exist only at import and cannot be recovered afterwards, but nothing yet proves they are
  usable for that.
- **No bound on stored form size.** A returned template is a few hundred kilobytes and the parser
  caps input at 4 MiB, so the database grows by roughly that per import with nothing pruning it.
- **Dedup is scoped to one deployment and one database.** Two installations sharing a wallet would
  not see each other's operations; that is the signer question above, deferred to Phase 6.
