# Vertical slice — issuance wired end to end, and what running the app found

## Ask

After an overview of what was built versus what was reachable, the user chose the
thin vertical slice: *"lets do this thin vertical slice just to be able to proceed further with less
untested-in-anger code."*

The point was not to add capability. Phases 2–5 had built a chain adapter, an intent model, a form
pipeline and a storage engine, and **every one of them was reachable only from tests** — `npm start`
could report status and check the network, and nothing else. This slice picks one path and makes it
real: a button, a save dialog, a recorded operation, a PDF on disk.

Scoped to **issuance only**. Import and the matrix report button are a second slice.

## Changes

Two ports, one use case, two adapters, a protocol bump, and the wiring on both sides of the IPC
boundary.

- **`FileSink`** and **`TemplateWriter`** — the two ports `ARCHITECTURE.md` had listed and nobody had
  written.
- **`issueOperationTemplate`** — the first application service that changes anything.
- **`FormTemplateWriter`**, **`NodeFileSink`**, **`templateAssets`** — the adapters behind them.
- **Worker protocol v3** — an `issueTemplate` request, `issued` and `refused` replies, and
  `schemaVersion` on `pong`.
- **`vite.worker.config.ts`** — externalizes `node:*`. See below; this is the finding of the slice.

## The use case is only an order, and the order is the point

Every component it composes already existed. What it adds is:

```text
resolve the organ -> build the bytes -> record -> write the file -> EMITTED
```

**Resolve first**, because the identifier printed on a governance document must be the contract's own
rendering, verified against it. **Build before recording**, because the record stores what the
template actually printed — a second composition of the same values could differ, and a tamper check
between two renderings would report a forgery whenever one changed. **Record before writing**, which
is what `DECISIONS.md` requires: bytes in memory are not an emitted document, a file on disk is.
**`EMITTED` last**, so a failed write leaves the row `RECORDED` — which is exactly what that state
means, rather than a case to guard against.

A refusal happens before any of it, so nothing needs cleaning up and the audit trail has no entries
for operations that never happened.

## A contradiction in the schema, found by trying to use it

`CREATE_NUMERICAL_VALUE_VOTING` **cannot be issued**, and the reason is two comments in one file that
cannot both hold.

`FIELD_PLAN` lists its `decimals` as **bound** — *"the scale the cell had when the template was
issued"* — and in the same table lists that operation's `x` and `y` as **member-filled**, on the
grounds that *"a bound cell would make the matrix reference report pointless."* At issuance there is
therefore no cell, so there is no scale to record. It is the only one of the eleven with a bound value
issuance cannot supply; the other ten are the organ triple and `votingId`, both of which come from the
request.

Neither side was corrected. Which one gives is a product decision — either the app asks for the
coordinate at issuance, or `decimals` stops being app-authored and loses the protection its own
comment describes ("a template issued against a two-decimal cell and returned after a decimals voting
changed it to four would otherwise submit a number a hundred times too small"). What the code does
instead is refuse with `BOUND_VALUE_UNAVAILABLE` and say why, rather than record a scale it invented.

## What running the app found

This is what the slice was for, and it produced three things no test would have.

### 1. The worker was never being built for Node

```text
"DatabaseSync" is not exported by "__vite-browser-external:node:sqlite"
[main] worker started (restart)   ×40
```

`worker.js` **was not written at all**. `utilityProcess.fork` found no file, the supervisor restarted,
and the log filled with restarts until the attempt limit. Nothing in that says "your bundler dropped a
module".

The cause is precise: Vite externalizes Node built-ins from `module.builtinModules`, and on the Node
that runs this build (22.14) **`node:sqlite` is not in that list** — verified directly,
`builtinModules.includes('sqlite')` is `false`. So it fell through to the browser-external stub.

It had never surfaced because **the worker had no `node:*` import at all** until it opened a database:
chain reads, the clock and the network guard all go through viem. `node:path`, added in the same
commit, was externalized correctly — which is what made the failure look specific to SQLite when it is
really about which names that list happens to contain.

Fixed with `external: [/^node:/]`, prefixed specifiers only. The next built-in to arrive will be
missing from that list too.

### 2. A startup error on every launch, since Phase 1

```text
Error sending from webFrameMain: Error: Render frame was disposed before WebFrameMain could be accessed
    at pushWorkerHealth
```

The worker reports `HEALTHY` within milliseconds of `app.ready`, before the first frame has committed.
`isDestroyed()` returns `false` and `send` throws anyway.

A `try`/`catch` was the first fix and it **silenced nothing**, because Electron logs that error itself
before the throw reaches us. The only fix is not to send: main now tracks windows that have emitted
`did-finish-load`, withdrawing readiness on `did-start-loading` so a reload has to earn it again. The
`try`/`catch` stays anyway, for the race between the check and the send, and has a test.

Confirmed by a clean run: `Render frame was disposed` occurrences went 1 → **0**.

### 3. The worker's console output does not reach the terminal in dev

`stdio: 'inherit'` is set, and no `[worker]` line ever appeared — not the store's schema version, not
its failure path. The database was verified another way (below). This is an observability gap, not a
malfunction, and it means the worker has been running blind since Phase 1.

## Evidence: it actually issued forms

Read out of `%APPDATA%/zarya-light/zarya.db` after the run — the file the application created, not a
fixture:

```text
user_version : 1          journal_mode : wal
tables       : cursors, operations
operations   : 5 rows

CREATE_MEMBERSHIP_VOTING             organ printed: 15.0.СОВ   from code: 15
CREATE_MEMBERSHIP_REVOCATION_VOTING  organ printed: 15.0.СОВ   from code: 15
TRANSFER_CHAIRMANSHIP                organ printed: (none)     from code: (none)
CREATE_CATEGORY_VOTING               organ printed: 13.0.СОВ   from code: 13
CREATE_CATEGORICAL_VALUE_VOTING      organ printed: 15.КОН     from code: 15
```

Five operations, all `EMITTED`, so every one of them recorded a row, produced a document and wrote it
to a path chosen in a save dialog. What each column proves:

- **WAL is on and the migration ran** — the pragmas and the migration runner work in Electron's Node
  24, not just in vitest's 22. The `-wal` and `-shm` files exist beside the database.
- **The organ identifiers came from the deployed contract.** `resolve()` verifies the contract's
  rendering against the local mirror and throws on disagreement, and a throw becomes a refusal that
  never reaches `EMITTED`. `15.0.СОВ` and `15.КОН` are Sepolia's answers.
- **The ordinal/code split held under real input.** `bound_values` stores subject code `15`; the
  ordinal appears nowhere. A `RegionalConference` row carries a region and **no** `organNumber`, a
  `LocalSoviet` row carries all three, and `TRANSFER_CHAIRMANSHIP` carries `{}` — the scope rules
  `buildIntent`'s reader expects, produced by a different module.
- **`CryptoIdGenerator` met the primary key.** Five real `zar-<uuid>` references, which the previous
  worklog listed as unverified.

## Tests

`issuanceRoundTrip.test.ts` is the one worth naming. `formRoundTrip.test.ts` already proved a filled
PDF becomes the right intent, but its bytes come from a fixture that writes field names and its
operation record is an object a test invented — its own header says *"what is still missing is the
issuer."* This is the issuer: a real reference, a real row in a real SQLite database, a real PDF from
the real writer, parsed by the real parser and bound back to the row it was recorded under. Only the
chain and the disk are faked.

It catches what no component test could — whether the record's `boundValues` are shaped the way
`buildIntent`'s reader asks for them. Both halves look right alone; only meeting in the middle shows
whether they agree on *which keys*.

Two smaller ones earned their place by failing first. The supervisor's reply guard rejected a
v2-shaped `pong`, which is correct and is now a test of its own for partial upgrades. And the
`CAST_VOTE` intent shape was richer than I assumed — `{ voting: { kind: 'ID', … }, direction }`, with
no organ, because `castVote` reads the organ from the voting.

`vitest.config.ts` gained `testTimeout: 20_000`. A form test issues all eleven templates and each
embeds PT Sans whole (~327 KB, a deliberate decision), so it was already near the 5s default; files
run in parallel, so the margin depended on how busy the machine was, which is the worst way for a
suite to fail.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  64 passed (64)
      Tests  877 passed (877)

$ npx electron-forge start
target built src/worker.ts
[main] worker started (initial)
Render frame was disposed: 0 occurrences
```

Up from 60 files / 832. New: `issueOperationTemplate` (19), `issuanceRoundTrip` (5),
`formTemplateWriter` (8), `ipcIssuance` (12), plus two in the electron suites. No new npm dependency.

## Unverified

- **Only issuance is wired.** Import, preflight and the matrix report button still have no caller;
  `assembleFormInput` and `bindOperation` are exercised by the round-trip test but not by the app.
- **`CREATE_NUMERICAL_VALUE_VOTING` cannot be issued** until the schema question above is answered.
  Ten of eleven work.
- **The issued PDFs were written and never opened.** Five real documents now exist on the user's disk
  and the standing question since Phase 4 — how Acrobat renders the Cyrillic, and what happens when a
  member types into a field — is still open. It is now one double-click away rather than a fixture
  away.
- **Nothing has been imported back through the app.** The round trip is proven in a test, not through
  the UI, and there is no import button to prove it with.
- **The worker's log is invisible in dev.** `stdio: 'inherit'` is set and no `[worker]` line reaches
  the terminal, so the store's own startup message has never been read. The database was verified by
  opening the file instead.
- **The packaged build is untested.** Everything here ran under `electron-forge start`. `?inline`
  assets and the `node:*` externalization are both build-shaped concerns, and an asar has not been
  made since they changed.
- **`app.getPath('userData')` is passed but its failure is not exercised.** A worker started without
  `ZARYA_USER_DATA` reports the reason; nothing has run it that way.
- **The save dialog's overwrite path is untested.** `FileSink` truncates deliberately, on the grounds
  that the dialog already asked — which is a claim about Electron's dialog, not something asserted
  here.
