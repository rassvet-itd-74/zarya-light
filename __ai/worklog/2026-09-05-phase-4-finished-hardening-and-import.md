# Finishing Phase 4 — ingestion hardening, and the return half gets a caller

## Ask

*"Finish completely with 4 then move to five"*, and — mid-slice, when I had scoped it as hardening
only — *"and the import!"*. So the scope is Phase 4's whole remainder: five ingestion gaps, four
missing hostile fixtures, and the import path wired end to end. Receipt writing stays out, because
the plan itself puts it in Phase 6 where a confirmed transaction exists.

## Changes

**Hardening.** `pdfHazards.ts` (compression bomb, embedded files, external references, depth) and
`fieldAppearance.ts` (reading a field's drawn text back), both wired into `pdfFormParser`, whose
`FIELDS` arm gains a `disclosures` list. Four fixtures added and one corrected.

**Import.** `importReturnedForm` in `src/app/`, a `FileSource` port with `NodeFileSource`,
`describeIntent` in the domain, an `importForm` worker request at protocol **v5**, an IPC channel, a
preload key, and a review panel that lists the intent field by field.

880 → 950 tests. Six new files, and no new dependency.

## Everything here was probed, and every probe changed the design

This is the part worth reading, because in three places out of three my first design was wrong in a
way only measurement showed.

**The compression bomb.** 200 MB of spaces compresses to 204 KB — **1029×** — so the existing 4 MiB
file cap permits roughly 4 GB of inflate. But pdf-lib turns out never to touch a *content* stream:
that file loaded in **4 ms** with no measurable allocation. An **object** stream is different, and is
inflated during `load` — 434 ms. So a bound checked on the loaded document would run *after* the
allocation it exists to prevent, and the check has to be on the raw bytes. `zlib`'s own
`maxOutputLength` does the enforcing, which means zlib stops at the bound rather than finishing and
being measured.

The scan is deliberately approximate — it frames `stream`…`endstream` without resolving the object
model — and it is safe in that direction: a misframed span yields a candidate that fails to inflate
and is ignored, never a legitimate form refused. `LZWDecode` is not covered and is written down
rather than papered over.

**The depth bound.** I assumed pdf-lib would blow a stack. It does not: probed at 100, 1 000, 10 000
and 100 000, it parses the first two and at 10 000 fails to parse the object and throws a
`TypeError` the parser already reports as unreadable. So the library never needed protecting from
depth — **the recursive hazard walk I was about to add did**. The bound stayed; its justification
changed completely.

**The appearance check.** Two corrections, in sequence.

First, `appearanceDisagreesPdf` — a fixture that had existed since slice 2 — **never contained a
disagreement at all**. `createTextField` without `addToPage` creates no widget annotation, so
`setText` generates no appearance and there was nothing for a value to disagree with. The old test
passed because it only asserted `/V`. Found by writing a check against it and getting nothing.

Second, my extractor skipped hex strings, reasoning that hex is what a glyph-identifier encoding
looks like. pdf-lib writes **every** appearance string as hex, including the plain WinAnsi bytes a
standard font produces, so the check could never have established anything about any field. What
actually separates a readable appearance from a glyph-encoded one is the printable-ASCII test, not
the string syntax.

## The appearance disclosure, and why it nearly shipped as noise

With the fixture and the extractor both fixed, the import round trip started reporting
`APPEARANCE_DISAGREES` on **every field a member had filled**. That is factually correct about the
file — a viewer that writes `/V` without redrawing leaves a blank appearance beside a real value —
and it would have been useless. A tamper warning that fires on every legitimate import is a warning
nobody reads, which is worse than not having one.

Two refinements, both principled rather than tuned:

- **`/NeedAppearances` skips the comparison.** It is the document declaring its own appearances
  stale and asking for a redraw. What a field currently draws then says nothing about what anyone
  saw, so there is nothing to compare — reporting a disagreement would be reporting the flag.
- **An empty appearance is "not established", not "disagrees".** It establishes nothing. A
  *substitution* shows one real value where another is stored, both sides non-empty, and that is
  still caught.

Probed, not assumed: pdf-lib does **not** set `/NeedAppearances` when it saves with
`updateFieldAppearances: false`, so the second rule is the one carrying the weight and the first is
there for viewers that do the honest thing.

The standing rule is written into the module: **silence means "not established", never "they
agree"**, and no caller may read it as the latter.

## Why attachments and outward actions are refused at all

Nothing in a PDF can steer a governance decision here — only field names and values are ever read.
The reason is narrower and it decides how strict each check should be: **Phase 6 stamps a receipt
onto the file the member returned and hands it back out.** Anything hostile left in it would be
re-published over this application's name. A form carrying one was also rebuilt, since no template
this application issues has an attachment or a remote action.

`SubmitForm` is the one that matters most on a form — a viewer offering to send a member's filled
governance data to somebody else's server is the attack this document type invites.

**PDF JavaScript is still tolerated**, which is now an inconsistency rather than a settled position:
the re-emission argument applies to it just as much. I left the existing decision alone and flagged
it, because tightening what the application refuses is a product call and the current behaviour is
documented and tested.

## Import: the order is the whole design

```text
read -> parse -> find the record -> bind -> assemble -> resolve -> build -> RETURNED
```

- **`RETURNED` is set last, and only if an intent was built.** Anything that fails leaves the
  operation in `EMITTED`, so a member can fix the file and import it again. Advancing first would
  burn an operation on a typo — or, worse, on an RPC outage.
- **An unreadable cell is a refusal, never a default.** `addValue` takes no decimals argument, so a
  guessed scale is a valid transaction storing a number off by a power of ten and nothing on chain
  would notice. This is the payoff of the 2026-09-04 `resolved` category, and its first real caller.
- **A second copy is refused rather than imported twice.** `bindOperation` resolves a `RETURNED`
  record deliberately — so a stale copy finds the completed operation instead of looking unbound —
  and naming that state is what turns the design into an answer a person can act on.
- **`resolved` keys are iterated from the schema**, not special-cased for the one operation that has
  them. A second one needs no change in the use case, and an unknown one refuses rather than
  silently omitting a field the member never saw.

`describeIntent` exists because a `bigint` does not cross a process boundary reliably and a
coordinate read as a number addresses a different cell. It also converts a region ordinal to its
subject code, since the two differ for 50 of 98 regions — the reply guard refuses a non-string field
value, so a worker that skipped it fails loudly.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  70 passed (70)
      Tests  950 passed (950)          # was 924 after hardening, 880 at the start of the day
```

`ai:validate` reports 16 skills, 59 documents, 71 ABI and 1,857 source symbols cross-checked.

The bomb test asserts the **clock** as well as the code: 200 MB of payload refused in under two
seconds, which is what says zlib stopped at the bound instead of inflating and being measured.

`npm start` builds all three bundles — `preload`, `main`, `worker` — and reports
`[main] worker started (initial)` with no restart loop and no preload error. The worker bundle now
pulls in `node:zlib` and the import use case on top of what the report added.

## Unverified

- **The import button has not been pressed.** Every layer is tested and the use case runs the whole
  loop through a real SQLite database and real PDF bytes, but click → dialog → worker → review panel
  was not done end to end. That seam is where the last three slices each found a real defect, and it
  is the outstanding item.
- **No form has been filled in a real PDF viewer and imported.** Every filled fixture in this suite
  is written by pdf-lib, which is one writer with one set of habits — and two of this slice's three
  corrections came from pdf-lib's habits specifically. What Acrobat leaves in a saved form, and
  whether it sets `/NeedAppearances`, is exactly the question the appearance check turns on and it
  is untested.
- **The appearance comparison is ASCII-only by construction.** Cyrillic free text drawn with an
  embedded font encodes glyph identifiers, which cannot be read back without the font's own mapping.
  So a substitution in a theme or a statement would not be detected — only in addresses, numbers,
  coordinates and amounts. Deliberate, documented in the module, and a real limit.
- **`LZWDecode` bombs are not bounded**, only Flate.
- **PDF JavaScript remains tolerated** while attachments and outward actions are refused. Inconsistent
  by my own argument; a decision for the product owner.
- **Nothing is submitted.** Import ends at a typed intent. There is no preflight call on this path
  and no signing anywhere in the application, so "imported" means understood, never accepted.
