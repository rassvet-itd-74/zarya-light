# Matrix report slice 1 — the coordinate index, the pinned reads, and the report model

## Ask

"Let's pick it up from where we left off", then a choice between three next slices; the user picked
**closing out Phase 4's matrix report** over Phase 5 slice 2 and over wiring the database into the
app. They also confirmed `section.context` = «Блок контекстуальных полей» as settled terminology,
which closes the one open item from the wording slice.

The report is more than one slice — it is a projection, a set of reads, a domain model, a landscape
PDF renderer, a new fill-in file of Russian strings, and a UI button. This slice is the **read model**:
everything up to but not including ink. That ordering is deliberate rather than convenient — the
renderer's layout depends on what the model actually contains, and the wording ask is one file the
user fills once, so it should be asked for when every slot is known.

## Two documentation errors found before writing anything

**`ARCHITECTURE.md` listed three ports that did not exist.** `MatrixIndex`, `MatrixReportWriter` and
`FileSink` were all in the driven-ports table — `MatrixIndex` even annotated *"chain — partial"* — and
`grep` for all three across `src/` returned nothing. `ZaryaMatrixEvents` was a bare class implementing
no port. Two of the three now exist; the table is corrected rather than left describing intent as
fact.

**The skill asks for a test that cannot be written.** `zarya-matrix-report` lists "an approval
threshold renders against its own base — `5000` of `10000` shows as 50%, never as 5000%" among the
report's tests. There is **no eligibility getter** (`CONTRACT.md`, "Not exposed"), so no threshold can
be read, and nothing in this report is a basis-point value. Recorded in `IMPLEMENTATION_ORDER.md` as
a skill-versus-contract mismatch rather than quietly satisfied by inventing a threshold display —
which is precisely the UI the plan says not to design.

**And one correction to my own previous entry.** The Phase 5 slice 1 worklog lists `IdGenerator` as
"still unimplemented". It is wrong: `cryptoIdGenerator.ts` has been in the tree since Phase 1
(`1584b21`) with both a CSPRNG and a sequential test implementation. `operationRef`s in tests are
literals by choice, not by absence. Corrected below rather than left standing as a false open item.

## The rule that is easy to get backwards, and the reason this slice has a fold at all

Matrix state changes only through a successful voting, so the event stream is a *complete* coordinate
index rather than a sample. But the two routes into it are not symmetric.

`ValueAdded` and `CategoryAdded` fire from inside `_executeApprovedSuggestion`, so their presence *is*
the evidence a voting passed. Ungated, cheap, done.

`setDecimals`, `setTheme` and `setStatement` **emit nothing at all**. A theme change is observable only
as a creation event joined to `VotingFinalized(success = true)`. And because the mutation runs inside
`executeVoting`, not inside `createThemeVoting`:

> **application order is finalization order.** A theme proposed in block 10 and executed in block 900
> overwrites one proposed in block 20 and executed in block 500.

A fold ordered by creation gets that backwards and prints the losing theme. So `foldMatrixIndexWindow`
resolves "last one wins" by the **finalization** log's position, and it carries unmatched proposals
across windows — a voting runs for hours or days, which at Sepolia's block time is far more than one
5 000-block window, so a fold that forgot proposals at a boundary would lose nearly every theme.

`logIndex` is part of that position and is **required rather than defaulted**. Two theme votings
executed in one block are ordered by it and nothing else; a log arriving without one is dropped,
because defaulting to zero turns them into a tie the fold breaks arbitrarily and is right half the
time.

## Changes

**`matrixIndex.ts`** — the fold, in the domain, with no chain in sight. Three coordinate sets rather
than one list with an attribution field: `categorical` (from `CategoryAdded`, self-attributing since
categories exist only there), `numerical` (from a finalized decimals voting), and `unattributed`
(from `ValueAdded`, which carries no `isCategorical`). A coordinate is promoted out of `unattributed`
once a route names its matrix, and never demoted, so the report does not spend a pair of reads
re-deriving what the events established.

Re-folding a window is idempotent, which is what lets the cursor commit only *after* a window is
handled: coordinates are a set, and an axis entry is replaced only by one with a later position. There
is a test that replays an old window and shows it cannot resurrect a superseded theme.

The `STATEMENT_PROPOSED` event drops its own `x`. `setStatement(isCategorical, x, y, …)` uses `x` only
to require a theme there and then writes `statements[isCategorical][y]`, so keeping it would split one
statement row into several and imply an addressing the contract does not have.

**`matrixEvents.ts`** — six fragments in one filter, up from two, and now implementing `MatrixIndex`.
One `getLogs` rather than the two `votingDiscovery` uses, because there every fragment in the second
request was unwanted traffic and here every fragment is read. The old `MatrixChange` type is **gone**
rather than kept beside the new one: two shapes for one stream would be two versions of one rule, and
only one of them under the fork test.

**`MatrixSnapshotReader` and `matrixSnapshot.ts`** — a second matrix port, and the split is the piece
of this slice most worth arguing with.

`MatrixReader` reads the **head**, because preflight predicts what happens if a transaction is sent
now, and pinning it would predict against state the chain has left. A **report** is a document: read
across the moving head, a theme could come from block N and the value under it from N + 2, so the page
would print a pairing that never existed on chain with nothing able to reveal it. So every report read
is pinned, and `ZaryaMatrixSnapshot` composes `ZaryaMatrixReader` — now taking an optional
`blockNumber` — rather than duplicating its decoding.

The pin is **`head - confirmations`, not the index cursor**, and that is a trade rather than a
preference. The cursor would make the document perfectly self-consistent, but a cursor mid-backfill is
millions of blocks back and reading *state* there needs an archive node, which public Sepolia is not —
the report would fail exactly when most needed. The confirmed head is reorg-safe and always served.
When the cursor is behind it the model reports `indexBehindBy` and the incompleteness runs one way
only: a cell created in the gap is *missing*, never misdescribed.

**The empty-checkpoint sentinel.** `getLatestCategoricalValue` returns
`{timestamp: 0, author: address(0), value: 0}` for a cell nothing was written to, rather than
reverting (`Matricies.sol:334-349`). Printed as read, that row claims a real value of `0`, authored by
the zero address, at midnight on 1 January 1970 — and a voter cannot detect any of the three. It is
recognised by its **timestamp**, the only field of the three that cannot occur naturally, since
`addValue` records `block.timestamp`. A `value === 0` test would have destroyed the case it needs to
preserve: a real zero by a real author, which has a test.

**`matrixReport.ts`** — the model. Rows grouped by matrix then ascending by `x` then `y`; axis
inventory as its own section, because it is what a voter needs to propose a *new* value and it is the
part populated first.

Themes are read once per column and statements once per row — they are addressed by `x` and `y` alone,
so one read serves every cell in the line. That cache is only sound *because* the snapshot is pinned;
caching a moving read would be caching two blocks under one key.

## Where the skill's two failure rules contradict each other, and how it was resolved

The skill says both "a report with a missing row must say the row failed to load, never silently omit
it" and "if a read fails outright, fail the report rather than printing a partial matrix that looks
complete". Taken literally the second swallows the first.

Resolved by the two halves having different sources. The **cell table** is read-derived: a row whose
every field is unread carries nothing but a coordinate. The **axis inventory** is event-derived — the
creation events carry the label text — so it is real content even when every confirming call times
out, and refusing to print the party's own themes over a network blip helps nobody. So:

- a failed read marks its own field and **keeps the row**, coordinates intact;
- the report fails only when it would be nothing but empty rows;
- an empty matrix, which attempts no reads, is a valid report and can never be confused with an
  outage.

My first implementation had the cruder rule — no read answered anywhere means failure — and a test
written for a different purpose caught it: an index holding one theme and an unreachable provider
returned `FAILED` while sitting on a perfectly printable inventory. The rule was wrong, not the test.

The axis confirmation is a four-way answer rather than a boolean: `MATCHES`, `DIFFERS` with the
chain's own text, `ABSENT_ON_CHAIN`, and `UNREAD`. `DIFFERS` is the interesting one — it means a later
voting the index has not seen, or a projection built against the other deployment, and picking a side
would hide both.

An `AMBIGUOUS` coordinate — bound in **both** matrices, which is reachable because the two are
independent mappings over one coordinate space — prints as **two rows**. That is the skill's "show
both or neither": one row would be a coin flip printed as a fact.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  58 passed (58)
      Tests  786 passed (786)
```

Up from 55 files / 717 tests. New: `matrixIndex` (22), `matrixReport` (28), `matrixSnapshot` (13),
plus 6 added to `matrixEvents`. **The fork tests ran** (`ZARYA_FORK_RPC_URL` was set), so the widened
six-fragment filter was exercised against the real deployment: it returns nothing, which is now a
broader claim than before — nothing applied *and* nothing proposed, and the one voting that exists
never finalized, so there is not even a `VotingFinalized` log to gate with. No new npm dependency.

## Unverified

- **Nothing renders.** There is no `MatrixReportWriter`, no landscape layout, no page, no PDF. The
  model has never been drawn, so nothing has checked that a row fits a printed line or that the
  staleness stamp has somewhere to sit on every page.
- **No `report.*` wording exists.** Every label this document needs is still unwritten, in either
  language, and the fill-in file the user has to complete has not been generated. That is the first
  thing slice 2 owes.
- **The report has never been assembled against a chain.** Every test uses a fake snapshot reader.
  The fork deployment has an empty matrix and no matrix votings at all, so even a fork test would only
  exercise the empty-report path — the populated one needs a local anvil with themes, statements and
  values written, which no fixture builds yet.
- **`indexBehindBy` is computed but nothing supplies `indexedThrough`.** No caller reads the cursor
  and passes it, because there is no application service yet. The disclosure is implemented and
  unwired.
- **Multicall is not used.** Reads run at a bounded concurrency of ten, which is "batch" in the loose
  sense and not what the skill asks for. Proportionate today — the live matrix is empty and a report
  is user-initiated — but a matrix of a few hundred cells would be several hundred sequential-ish
  round trips, and `callContract` has no multicall path to hang it on.
- **Archive access is reasoned, not measured.** The claim that `head - 12` state is served by public
  Sepolia endpoints while a mid-backfill cursor is not comes from how non-archive pruning works, not
  from a failed request against a real provider at both depths.
- **`Panic(0x32)` from `get*ValueAt` is untouched.** The report reads only `get*LatestValue`, which
  does not panic. Indexed and historical reads are not in this model at all, so the panic that
  `CONTRACT_DEFECTS.md` warns about has no call site to reach.
