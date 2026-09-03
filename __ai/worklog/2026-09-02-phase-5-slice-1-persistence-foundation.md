# Phase 5 slice 1 — the storage engine, migrations, and the trust anchor

## Ask

"ok proceed", with the 61 Russian strings still outstanding. So the choice of work was itself part of
the ask: the matrix report is the other thing left in Phase 4, and it is a **printed Russian
document** that would only add more pending labels. Persistence needs no wording at all, is the
blocking dependency for Phases 6, 7 and 8, and closes a gap slice 3 left live — issuance takes an
`operationRef` that nothing recorded. Plan order says Phase 4 then 5; this deviates from it for that
reason rather than by drift.

## The engine was chosen by running Electron, not by reading release notes

`node:sqlite` against `better-sqlite3`, and the deciding fact had to be measured: **Electron 43.4.1
bundles Node 24.18.1, and `DatabaseSync` works there** — a probe created a table, inserted, and read
the row back inside a real Electron main process.

That matters because `better-sqlite3`'s cost is a native module: an ABI rebuild against Electron's
Node, a *second* build for the Node that runs vitest, and `plugin-auto-unpack-natives` in the
packaged app. Two builds of a C++ dependency is the class of thing that works on one machine and
fails in CI. `node:sqlite` is already in both runtimes, so there is nothing to compile and the API is
identical in tests and in production.

**The cost, stated rather than buried:** it is experimental, Node 22 emits an `ExperimentalWarning`
for it, and the API may change. Two things bound that — only `DatabaseSync`, `exec`, and
`prepare`/`get`/`all`/`run` are used, which is the part any SQLite binding has, and the whole surface
sits behind two ports. There is also a **version skew**: tests run on the Node running vitest (22.14
here), production on Electron's 24.18. The same module name in two runtimes is not the same guarantee
as the same module — but it is still strictly better than needing two separately compiled binaries.

## Changes

**`issuedTemplate.ts`** — the state machine `STATE_MACHINES.md` specifies, as a transition table. The
transition carrying a correctness rule rather than bookkeeping is `RECORDED -> EMITTED`, and the test
for it asserts the inverse: `EMITTED` is reachable from `RECORDED` **and from nowhere else**.

Two absences are deliberate and tested. `EMITTED` has no failure edge, because a template may simply
never come back and that is the normal case rather than a stuck job. And nothing returns to
`REQUESTED`: reissuing is a new `operationRef`, not a rewind, because the old file is still out there
and still has to resolve to the operation it names.

`canBindReturnedForm` includes `RETURNED` and `SUPERSEDED` on purpose. A second copy of an
already-imported form has to resolve to the **completed** operation so dedup can call it a duplicate;
resolving to nothing would let a stale form be treated as unbound and fall back to its own values.

**`OperationStore`** — the port, and it inverts this codebase's own `undefined` convention with a
reason. Every chain reader returns `undefined` for "could not ask", because a read can fail without
the answer being negative. A local store either has the row or does not, so implementations **throw**
on I/O failure and `undefined` is a fact. A store that swallowed a disk error into `undefined` would
turn a broken database into a stream of forms reported as forgeries.

**`database.ts` / `migrations.ts`** — `PRAGMA user_version` rather than a migrations table: it is an
integer SQLite maintains itself, it cannot disagree with the schema it describes, and there is no
bootstrapping problem where the migrations table needs a migration. Each migration runs in a
transaction *with* its own version bump, so a failure leaves the previous version rather than a
half-applied schema — tested by feeding the runner a deliberately broken statement. A database from a
newer build is refused rather than migrated downwards.

`synchronous = FULL` is not the default, and the reason it is set is this store's entire purpose:
`NORMAL` can lose the last transactions on an OS crash, and an `operationRef` written and then lost is
a form emitted against no record.

**`inTransaction` is synchronous, and that is the API doing the enforcing.**
`zarya-persistence` says never hold a transaction open across an RPC call; a signature that cannot
accept a promise makes that impossible rather than discouraged.

**`SqliteOperationStore`** — uniqueness is the primary key's, not an `if`'s, because check-then-insert
is a race. `advance` reads the current state and writes the new one in **one** transaction, since the
machine's decision depends on the current state and two callers could otherwise both see `RECORDED`.
Rows are re-validated on the way out rather than cast: a database is a file on a disk the user owns,
and `STRICT` tables constrain SQL *types*, not whether a `TEXT` column holds an operation type this
build knows.

**`SqliteCursorStore`** replaces the in-memory cursor for production and does not retire it.
`block_number` is `TEXT`, not `INTEGER`, because `node:sqlite` hands an INTEGER column back as a
JavaScript `number` — fine for Sepolia's eleven million, silently wrong past 2^53. There is a test
that stores 2^60 and shows the `number` path losing it.

## A hole the bridge turned up

`boundOperation.ts` maps a stored record into what ingestion assembles against, and writing it
surfaced something the earlier slices could not have shown.

`assembleFormInput` never reads the chain id or the contract from a returned file — they are display
fields, compared and then ignored — **so the record is the only thing that says which deployment an
operation belongs to.** Without a check, repointing the application at the other deployment and
importing an old form would resolve its reference, recover its context, and build a perfectly valid
intent *for the wrong contract*. Two incompatible deployments exist (`DEPLOYMENT.md`), so that is a
reachable state. `bindOperation` refuses it as `WRONG_DEPLOYMENT`, and `NOT_EMITTED` is kept separate
from "unknown reference" because only one of the two suggests a database that lost rows.

## Two tests replaced by one better one

`memoryCursorStore.test.ts` had eight behavioural tests that `cursorStoreContract.test.ts` now runs
against **both** implementations. Keeping both copies would be two versions of one rule that could
drift, and the drifted one would be the copy nobody noticed. The file was trimmed to what the
contract suite cannot own — `cursorKeyOf`, which is a pure function, and the error's message, which
is a detail of that class. **Net coverage went up:** every rule previously checked against the
in-memory store alone is now checked against the SQLite one too.

## The boundary guards are now precise rather than approximate

Adding a `node:sqlite` guard beside the `pdf-lib` one exposed a flaw in how I had written the first
one: excluding a directory from an override exempts it from *every* rule in that override, so
exempting `store/` from the database rule also exempted it from the PDF rule.

ESLint replaces rather than merges `no-restricted-imports` across overrides, and the fix uses that
deliberately: one override for all of `src/` outside the domain carrying both rules, then a
forms-only override restating the database rule, then a store-only override restating the PDF rule.
All four directions were verified by writing a temporary offending import and counting errors — chain
importing either library fails, forms importing sqlite fails, store importing pdf-lib fails, and the
legitimate imports stay clean.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  54 passed (54)
      Tests  705 passed (705)
```

Up from 49 files / 644 tests, and that is net of removing eight duplicated cursor tests. New:
`issuedTemplate` (11), `database` (9), `sqliteOperationStore` (16), `cursorStoreContract` (20 across
two implementations), `boundOperation` (10). No new npm dependency — `node:sqlite` ships with the
runtime.

## Unverified

- **The database has never run inside the application.** The engine was probed in Electron, but no
  worker opens a file, no path is chosen, and `app.getPath('userData')` has never been called. The
  single-writer decision — the worker owns the database, main never opens it — is recorded and
  unexercised.
- **Only `node:sqlite` under Node 22.14 is tested.** Production is Electron's Node 24.18. The probe
  says the module works there; the *suite* has never run there, and that gap closes only when there
  is an Electron-hosted test.
- **`synchronous = FULL` and WAL are set, not demonstrated.** Nothing has killed the process
  mid-write and reopened the file. The crash-window tests `INVARIANTS.md` asks for are Phase 6's, and
  they are the only thing that would show these pragmas doing their job.
- **Concurrency is reasoned, not raced.** `advance` and `commit` are transactional so a concurrent
  caller cannot interleave, and no test runs two callers at once — `node:sqlite` is synchronous, so
  provoking a real race needs two processes, which is what the single-writer rule exists to avoid.
- **Nothing in the plan's Phase 5 list beyond this slice exists.** No form bytes stored, no receipt
  path or hash, no transaction record, no nonce, no batch or item state, no dependency edges, and no
  executor job table — so the `UNIQUE (chainId, contractAddress, votingId)` constraint the plan calls
  for is still absent. It is deliberately not a table with no writer.
- ~~**`IdGenerator` is still unimplemented**, so every `operationRef` in a test is a literal.~~
  **Wrong, corrected 2026-09-03.** `adapters/platform/cryptoIdGenerator.ts` has been in the tree since
  Phase 1 (`1584b21`) with a CSPRNG implementation *and* a sequential test one. The literals in these
  tests are a choice, not an absence. What stands is the narrower claim: no `operationRef` written to
  the database has come from `CryptoIdGenerator`, so the primary key's uniqueness has never met the
  real generator.
- **Nothing is wired to the worker, IPC, or the renderer.** `npm start` was not run; worker protocol
  stays at v2.
