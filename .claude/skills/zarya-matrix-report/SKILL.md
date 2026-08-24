---
name: zarya-matrix-report
description: Build the printable matrix reference PDF — the coordinate index voters consult to learn which (x, y) to write on a voting form. Covers the matrix coordinate index projected from events, organ label reverse lookup, current-value reads, staleness disclosure, and print layout. Use for the matrix report button, the read model behind it, or any matrix-wide read.
---

# Zarya matrix report

A printable reference showing what the matrix contains, so a voter filling a form knows which coordinates to write. Reached from a UI button; no signer, no chain write.

## It is a report, not a form

This is the one PDF the app produces that is **not** an AcroForm. No fields, no `zarya.meta.schemaVersion`, no `operationRef`, no ingestion path.

A report must never be mistaken for a submittable document. It already cannot be — ingestion rejects anything without a recognised `schemaVersion`, so no new guard is needed. Do not add form fields to a report to make it "more useful"; that would turn a reference sheet into something the pipeline has to reason about.

Reports are disposable output: a rendering of chain state, regenerable at any time, never a record.

## The coordinate index

The contract **cannot be asked what the matrix contains** — no dimension getter, no cell enumeration. Every matrix read is `(x, y)`-addressed, so you must already know the coordinate to read it.

The resolution, detailed in `__ai/references/CONTRACT.md`: matrix state changes only through a successful voting, and every such voting emits an event carrying its coordinates, so a projection over that stream is a **complete** index of existing cells, themes, and statements. It needs both event routes:

- **`ValueAdded` and `CategoryAdded`** fire at application time, so they need no gating and are the cheapest coordinate source. `ValueAdded` is absent from the ABI and needs a hand-written fragment. It carries no `isCategorical`, so read `getCategoricalCellOrgan` / `getNumericalCellOrgan` to learn which matrix a coordinate belongs to.
- **Themes, statements, and decimals** emit nothing on application, so project their creation events **gated on `VotingFinalized(success = true)`**. Creation alone means a change was only *proposed*; an ungated index lists cells that were never created.

**Reuse the executor's cursor.** `VotingDiscovery` already indexes this stream. The matrix index is a second projection over it, not a second scan.

## An empty matrix is a valid report

A young or sparsely used matrix will have axes and no cells, and the report must handle that as a normal state rather than an error or a blank page.

- Do not list *proposed* coordinates from unfinalized votings to make the report look populated. A coordinate that does not exist is one a voter cannot use, and printing it invites a form that fails preflight.
- Do not compute what a value "would have been" had a rejected voting succeeded.

Give the axis inventory real space rather than treating it as an appendix. It is what a voter needs in order to propose a *new* value, and it is the part that is populated first.

## Organ labels need a reverse table

Cell getters return a `bytes32` organ; `getPartyOrganIdentifier` produces a label from the triple. There is no getter mapping one to the other. So build a reverse index locally: enumerate plausible triples, call the `pure` `getPartyOrgan` for each, key by `bytes32`. This costs no state reads and the table can be cached indefinitely.

The enumeration space is smaller than it looks. `Region` has exactly 98 members (ordinals 0-97), and three of the eight organ types ignore region and number entirely, contributing **one entry each**. Two more use region but not number: 98 entries each. Only the two local types need a number range, and that range is the one genuinely open parameter. Bound it deliberately and say what the bound is; or resolve lazily, caching only organs actually encountered on a cell, which avoids the question.

Build the table with **enum ordinals**, never subject codes — a table seeded from codes looks right on the project's own region and is wrong elsewhere. See `CONTRACT_DEFECTS.md`.

Treat an unresolved `bytes32` as "unknown organ" shown verbatim. Never guess a label, and never omit the cell because its organ did not resolve — a voter still needs its coordinates.

This belongs behind `OrganResolver`, which needs both directions.

## Content

The coordinate is the point of the document, so lead with it. For each populated cell:

- `x` and `y`, rendered so they can be transcribed without ambiguity — no thousands separators, no line wrapping mid-number
- the axis labels: theme for `x`, statement for `y`
- categorical or numerical
- owning organ label, or the raw `bytes32` when unresolved
- allowed categories with names, for categorical cells
- decimals, for numerical cells
- current value with its author and timestamp, plus sample count

Also print the axis inventory on its own — themes by `x`, statements by `y` — since a voter proposing a *new* value needs to find the right row and column before there is a cell to look up.

## Staleness is a correctness concern

A printed matrix is stale the moment a voting executes. Someone will type coordinates from a month-old printout into a form.

- Stamp the **block number and chain timestamp** the report was read at, prominently, on every page. Not the workstation clock.
- Say plainly that the contents can change and that the app validates coordinates at submission.
- Never present a report as authoritative.

The real safety net already exists: preflight validates a form's coordinates against current chain state, so a stale coordinate produces a clear preflight failure rather than a wrong transaction. Say so on the page, so a voter understands a rejection is expected behavior rather than a bug.

## Reads are wide, so batch them

A full report is many reads: two or three per cell plus axis labels. Batch or multicall where the provider supports it, and make partial failure visible — a report with a missing row must say the row failed to load, never silently omit it. If a read fails outright, fail the report rather than printing a partial matrix that looks complete.

## Layout

- Landscape, and paginate by coordinate range with the range in a running header, so a printed stack stays navigable.
- Repeat column headers and the staleness stamp on every page.
- The Zarya logo from `src/assets/logo.png`; see the DPI note in `__ai/references/DEPLOYMENT.md`.
- Cyrillic organ labels must render — verify the embedded font covers the range rather than trusting a default.

## Hexagonal placement

Assembling the report model — which cells, in what order, with what fields — is a **domain** concern and testable with fake readers. Rendering it to PDF is an adapter behind a `MatrixReportWriter` port.

## Tests

- projection completeness: a cell created through a finalized voting appears; one whose voting failed does not
- a matrix with themes and statements but no populated cells renders as a valid report, not an error
- an approval threshold renders against its own base — `5000` of `10000` shows as 50%, never as 5000%
- an unresolved organ `bytes32` renders verbatim and does not drop the cell
- the organ reverse table is keyed by enum ordinal — assert on a region whose ordinal and subject code differ, since Chelyabinsk passes either way
- staleness stamp carries chain time, not system time
- a failed read fails the report rather than producing a plausible partial one
- Cyrillic labels survive rendering
- the output has no AcroForm fields, and feeding it to ingestion is rejected
