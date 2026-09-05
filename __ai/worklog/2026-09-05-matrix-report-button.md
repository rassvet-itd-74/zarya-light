# The matrix report button — the caller three finished slices were missing

## Ask

Second of the three the user ordered: *"Fix numerical value schema, then matrix report button, then
import."* The schema slice was finished and green but uncommitted; the user chose to start this one
on top of it rather than commit first, so both sit in the working tree together.

## What was already there, and what was not

Three slices had built the report and **not one line called any of them**:

- `matrixIndex.ts` / `matrixEvents.ts` — the coordinate projection (2026-09-03, slice 1)
- `matrixReport.ts` / `matrixSnapshot.ts` — the pinned read model
- `composeMatrixReport.ts` / `renderMatrixReport.ts` — the landscape document (slice 2) and its 37
  wording slots (slice 3)

`grep` for `assembleMatrixReport` and `MatrixReportRenderer` outside their own tests returned
nothing. So this slice is not the report; it is the **caller**, and the questions it had to settle
are the ones a caller owns: which blocks, pinned to what, what happens when a scan fails, and how a
request that is not a one-call probe travels through a supervisor built for one-call probes.

## Changes

**The use case.** `src/app/generateMatrixReport.ts` — pin, project, assemble, render, write — with
`MatrixSnapshotSource` added beside `MatrixSnapshotReader` in the port file. A source is separate
from a reader because it can fail in a way a reader cannot express: a reader always has an `at`, so
a provider that will not say what the head is has no reader to return.

**The protocol.** `WORKER_PROTOCOL_VERSION` 3 → 4, a `generateMatrixReport` request, a `reported`
reply, and guards for both. `workerProtocol.test.ts` is new — the guards had **no tests at all**
before this, which I noticed only because I was adding to them.

**Per-request timeouts.** `supervisor.request(spec, { timeoutMs })`, defaulting to the existing
ten seconds.

**The boundary.** A channel, a handler with its own gateway, a preload key, a button, and the
markup. `#issue-result`'s styling became a shared `.result` class rather than being copied.

Ten tests for the use case, eight for the channel, ten for the protocol guards, two for the
supervisor, one for the preload surface. 885 → 916.

## The decisions worth reading

### The projection ignores the discovery cursor, and that is the point

The skill says *"reuse the executor's cursor"*, and I did not. `CursorStore` persists a **block
number**; the folded index — which coordinates exist, which axis labels survived — is durable
nowhere. Resuming from a stored cursor without the state that produced it would skip every event
before it.

That is not a slow report. It is a **wrong** one, and wrong in the one way this document cannot
disclose: a coordinate that was never found leaves no gap on the page. A voter would read a matrix
missing rows with nothing to say so.

So the whole history is re-scanned on every press. The skill's advice is right about where this
ends up — it just needs the executor to exist first, and Phase 7 is where the shared cursor becomes
a shared *index*. Recorded in `IMPLEMENTATION_ORDER.md` so the next reader does not "fix" this by
wiring the cursor in.

The test that holds it is the first window's `fromBlock`. There is no cursor store in the
dependencies at all, and asserting the scan starts at the deployment block is what stops that being
merely an oversight nobody has corrected yet.

### The pin is chosen first, and the scan is bounded by it

`ZaryaMatrixSnapshot.atConfirmedHead` pins at `head - confirmations`. The projection then runs
`[deployment, pinned]` through `planDiscovery` with **`confirmations: 0n`** — the depth is already
applied, and passing the default would silently trim another twelve blocks off the index.

`planDiscovery` is reused rather than reimplemented so the provider-ceiling rule stays in one place.
Its `CURSOR_AHEAD` arm is unreachable from a cursor this function owns and is handled anyway: the
arm exists, and treating it as "done" would print a matrix missing everything after the pin.

A consequence worth naming: `indexedThrough` is exactly the pin, so `indexBehindBy` is **always
`undefined`** on this path and the gap disclosure never fires. That is correct rather than dead —
the field is for Phase 7 — and there is a test asserting this use case introduces no gap, so if the
bound ever stops matching the pin it fails here.

### A failed scan fails the report; a failed read does not

Two kinds of incompleteness and only one of them can be shown. A read that does not answer leaves a
row on the page to carry the marker, and `assembleMatrixReport` already prints those. A scan that
does not answer leaves **nothing** — so folding what arrived and printing the rest produces a
document that looks complete and is not. The scan error propagates.

### The supervisor's timeout was the real obstacle

`DEFAULT_REQUEST_TIMEOUT_MS` is 10,000, and a timeout also sets the worker `DEGRADED`. That is right
for `ping`: one call, and silence past ten seconds is evidence of trouble. A report is not one call.

Sharing the figure would mean choosing between aborting a working report and waiting minutes to
notice a dead worker. So the caller states what it is waiting for; the default stays honest for
everything that should be quick, and only this one request opts out, at five minutes.

Five minutes is not an expectation. It is an upper bound past which something is genuinely wrong,
chosen wide **because I could not measure the case that matters** — see below.

### `blockNumber` crosses as a string

A `bigint` does not survive `postMessage`'s structured clone, and nothing downstream does arithmetic
on it. The reply guard refuses a numeric one rather than coercing it: a block number is what the page
is stamped with, and a silent `Number()` on a value near 2^53 is the kind of thing that is correct
until it is not.

`degradedRows` crosses too, and the UI reports it. A report can be written *and* incomplete — the
page marks those rows — so a result type that dropped the count would let the panel claim a success
the document itself contradicts.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  67 passed (67)
      Tests  917 passed (917)          # was 885
```

`ai:validate` reports 16 skills, 58 documents, 71 ABI and 1,750 source symbols cross-checked.

**Then it was run against the real deployment.** A throwaway test drove `generateMatrixReport` with
the real chain adapters, the real renderer and `NodeFileSink` against Sepolia, wrote a PDF, and was
deleted afterwards:

```text
[live] 1064ms {"kind":"WRITTEN","pageCount":1,"blockNumber":"11642402","readAt":1788637008,
               "rows":0,"degradedRows":0,"empty":true,"scannedWindows":18}
[live] 32917 bytes on disk
[live] ingestion says REJECTED
```

What each part settles:

- **Eighteen windows**, exactly the count predicted from 88,798 blocks at 5,000 a window. The
  chunking, the zero-confirmation bound and the contiguity are not just unit-tested.
- **1,064 ms**, against my written guess of "tens of seconds". The guess was in four comments and a
  test; all five now say what was measured, and say that it is a **floor** rather than a typical
  figure.
- **`empty: true`, zero rows.** The matrix on this deployment has no coordinates *and* no axis
  labels. The young-matrix path is the one that ran.
- **Ingestion answers `REJECTED`** on the real bytes — the report cannot re-enter the submission
  path, by construction rather than by a guard.

The last of those is also the limit of the run, and the reason the timeout stayed wide: with no
cells, **no cell reads happened at all**, and the reads are the half that grows with the matrix.

**And the app was launched**, which is a smaller claim than it sounds and still worth making:

```text
[@electron-forge/plugin-vite] target built src/preload.ts
[@electron-forge/plugin-vite] target built src/main.ts
[@electron-forge/plugin-vite] target built src/worker.ts
[main] worker started (initial)
```

`target built src/worker.ts` is the line that matters. The worker now pulls in the matrix chain
adapters and `MatrixReportRenderer`, which drags pdf-lib and fontkit into that bundle for the first
time — and the last time this bundle gained an import, Vite silently resolved `node:sqlite` to a
browser stub and the worker was never emitted at all, presenting as a restart loop. It built. One
`worker started (initial)`, no restart loop, no `Render frame was disposed`, and no preload error, so
the widened `registerIpcHandlers` and the fourth `window.zarya` key did not break startup.

## Then the button was pressed, and the report was unreadable

The user clicked it and handed back the file. Its timestamp falls inside the window the launch above
was up, so this is the whole path for real: renderer → preload → validated channel → save dialog →
worker → 32,916 bytes on the Desktop. The transport works and the outcome line is right.

The document is not.

Rendered in a viewer — Chromium's, driven through Electron once `ELECTRON_RUN_AS_NODE=1` was cleared
out of the shell, which is what had defeated the same attempt earlier — «Отчёт по состоянию Зари»
came out as **scattered letters on a mostly blank page**. `б в д ц ф ч ь П Э Т ю` drew; `а е и о н с
т р л к м п у я` did not. Every heading, every sentence of the disclosure, both section titles:
fragments.

The cause is `{ subset: true }` on the report's font embedding, which the slice-2 renderer has
carried since 2026-09-03. Regenerating the identical model with the font embedded whole renders
every sentence correctly — «Заря», «Отчёт по состоянию Зари», «Блок: 11642563 · Время блока:
05.09.2026 20:10 UTC», «Оси», «Заполненные ячейки» — so composition and layout were never at fault.
pdf-lib's subsetter is.

**Fixed by embedding whole**, at ~326 KB against 33 KB. The reasoning for subsetting was sound — a
report has no fields, so nothing regenerates an appearance from the font and only the drawn glyphs
are needed — and it was an optimization of the wrong quantity. A reference sheet a voter cannot read
is worth nothing at any size. Why the subsetter drops those particular glyphs is not investigated:
the fix does not depend on the answer, and a governance document is the wrong place to carry a
workaround for a library defect.

### Every test passed while this shipped

That is the part worth keeping. `renderMatrixReport.test.ts` had eight checks including *"draws the
whole Russian alphabet in both cases, «ё» included"* — and all of them assert
`resolves.toBeDefined()`. **Rendering never throws.** A glyph the embedded font lacks draws as
nothing at all, so "the font encoded this text" and "a reader will see this text" are two different
claims and only the first was ever being made.

Worse, the one test that could have noticed was pointed the wrong way: *"produces a document far
smaller than a whole-font template"*, asserting under 120 KB. The broken subset came in at 46 KB and
passed. The test was measuring the symptom as if it were the goal.

It is replaced by one that asks the artifact: pull the `FontFile2` streams back out of the finished
PDF and check the embedded faces still carry all 66 letters. Verified in both directions — it passes
now, and with `subset: true` restored it fails with every letter listed and the size check alongside
it. A subset carries no `cmap` at all, so fontkit cannot even be asked about a code point; that
throw is caught and counted as total absence rather than crashing the suite.

`DECISIONS.md` now states the embed-whole rule unconditionally and says which half is empirical.
`ARCHITECTURE.md` and `IMPLEMENTATION_ORDER.md` both claimed the report was subset; both corrected,
the latter as a struck-through reversal rather than a silent rewrite.

**Then the button was pressed again on the fixed build, and the report reads correctly.** That
closes the path end to end: click, save dialog, worker, a legible document — on the empty matrix,
which is the only matrix that exists.

## Corrections made along the way

`templateLayout.ts`'s `hintDrop` comment still cited the ~1.6pt descender estimate that yesterday's
measurement (2.07pt) disproved — the wrong figure had survived into the constant's own
justification. Fixed, along with a misindented comment in `issueTemplate.test.ts` and the previous
worklog's test count, which said 884 where the suite reports 885: the hint-descender test was added
after that section was written.

## Unverified

- ~~The fixed report has never been produced through the button.~~ **Closed.** The user pressed it
  on the fixed build and confirmed the document reads correctly. So the full path — click, dialog,
  worker, legible PDF — is confirmed end to end, on the empty matrix. Recorded as the user's
  observation rather than mine: I rendered the whole-font version myself, but not the file that
  click produced.
- **The populated path has never run against real data.** Zero cells on chain means `buildRow`, the
  organ reverse lookup, the category names, the value column and the multi-page layout were all
  exercised by fixtures only. The page I looked at is the empty one; a populated report has still
  never been seen by anyone, and the defect above is exactly the kind that only shows up when
  looked at.
- **Only Chromium's viewer.** Acrobat is what members will use and it was not tried. It matters less
  for a report than for a form — nothing regenerates an appearance here — but glyph handling is
  precisely where the two are known to differ.
- **A form has no equivalent glyph check.** Templates embed the font whole and always have, so they
  are not exposed to this defect; but their Cyrillic tests are the same "did not throw" shape, and
  nothing would catch it if that embedding ever changed.
- **The five-minute timeout is a guess about a case that does not exist yet.** The measured second
  says nothing about a populated matrix, where the reads dominate.
- **The staleness sentence on the form is still unhonoured.** `SENTENCES.coordinateDisclosure`
  promises coordinates are checked against the report when a form is loaded back. Import is slice 3
  and will check the *cell*, not the report. Unchanged from yesterday's entry, and still the party's
  wording to change rather than mine.
- **One flaky failure, not caused by this work.** `networkGuard.fork.test.ts`'s reconnect case timed
  out at 180 s during a full-suite run, then passed standalone in 1.2 s and in every later full run.
  It starts an anvil fork and kills a provider, so it is load-sensitive. Recorded rather than
  investigated.
