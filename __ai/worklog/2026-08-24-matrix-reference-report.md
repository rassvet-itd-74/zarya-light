# Add the matrix reference report

## Ask

A button that prints a PDF of the full matrix contents, so voters can see which coordinates to write on the voting form PDFs. Alter the AI docs accordingly if applicable.

## Changes

Checked the ABI before writing anything, because the feature depends on being able to read the matrix. Two absences turned out to shape the whole design, and both are now in `CONTRACT.md`'s "Not exposed" table:

- **No matrix dimensions and no cell enumeration.** Every matrix read is `(x, y)`-addressed, so you must already know a coordinate to read it. The contract cannot be asked what the matrix contains.
- **No `bytes32` → organ label getter.** `getPartyOrganIdentifier` takes the `(organType, region, number)` triple while every cell getter returns `bytes32`.

The first looked like a blocker and is not. Invariant 1 says matrix state changes only through a successful voting, and every such voting emits an event carrying its coordinates — so a projection over the event stream is a *complete* coordinate index. Better, it is the **same cursor** the executor already maintains for deadline discovery, so the matrix index is a second projection over existing infrastructure rather than a new chain sweep. Gating on `VotingFinalized(success = true)` matters: creation events alone would list cells that were never created.

The second needs a locally built reverse table. Both organ helpers are `pure`, so enumerating plausible triples costs no state reads and the table can be cached permanently — the mapping cannot change. An unresolved `bytes32` renders verbatim and the cell is still listed; a voter needs its coordinates regardless.

New `zarya-matrix-report` skill rather than extending `zarya-pdf-forms`, which was already the largest at 166 lines. The split is clean because a report is **not a form**: no fields, no `schemaVersion`, no `operationRef`, no ingestion path. It therefore cannot re-enter the form pipeline, and ingestion rejects it automatically for lacking a recognised schema version — no new guard needed.

Treated staleness as a correctness concern rather than a cosmetic one. A printed matrix is stale the moment a voting executes, and someone will transcribe coordinates from an old printout. Every page carries the block number and chain timestamp it was read at, from chain time. The real safety net already exists — preflight validates coordinates against current chain state — so the page says so, making a rejection legible as expected behavior rather than a bug.

Also rewrote `USE_CASES.md` to drop letter-prefixed section and row IDs. Inserting a section had forced a full renumber three times in this session; sections are now referenced by name and rows numbered within their section, so an insert cannot disturb anything else. Fixed the one live cross-reference in `zarya-batch-engine`; left the letters in earlier worklog entries, since those accurately record what the file looked like at the time.

## Evidence

```text
npm run ai:validate → exit 0   (16 skills, 36 documents, 6 worklog, 70 ABI symbols cross-checked)
npm run typecheck   → exit 0
npm run lint        → exit 0
```

The two ABI absences were established by query, not assumption: searched the ABI for any function matching size/length/count/dimension/total/max/all, and for any function taking `bytes32` and returning `string`. The first returned only per-cell `(x, y)` getters; the second returned nothing.

## Unverified

No PDF library is chosen, so nothing about report rendering has been exercised — including whether the chosen library's default fonts cover Cyrillic, which the skill flags as needing explicit verification rather than assumption.

The enumeration bound for building the organ reverse table is unspecified. Eight organ types across roughly ninety regions with an unknown number range could be a large sweep; the skill says to bound it deliberately but does not say where, because the plausible range of local organ numbers is a product question.

Whether a full-matrix report is practical at scale is untested. It is the widest read in the app — two or three calls per cell plus axis labels — and no real matrix exists to measure against.

## Follow-ups

- Decide the organ enumeration bound, or resolve labels lazily for organs actually encountered.
- Batching or multicall for the per-cell reads, once a chain library is chosen.
- Landscape pagination by coordinate range is specified but unproven against a real matrix shape.
