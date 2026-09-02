# Phase 4 slice 3 — issuance, the embedded font, and the full round trip

## Ask

The user asked whether they should prepare the PDF templates or whether this could. Answer: this
does — `DECISIONS.md` already settles that templates are *generated* and reproducible so a fixture
can pin them, and a hand-prepared PDF would be an untracked binary whose field names nothing could
check against `FIELD_PLAN`. Three things were genuinely theirs, and they supplied all three: PT Sans
in `src/assets/pt-sans/` with its OFL licence, Russian-only wording (to come, per the enumerated
list), and A4 plus the coordinate disclosure.

## The font risk was the reason this slice waited, and it is retired

Eight probes before any code. The premise held: **`StandardFonts.Helvetica` genuinely throws
`WinAnsi cannot encode "С" (0x0421)`**, so an embedded font is not a nicety. And the thing slice 2
recorded as unverified — that a Cyrillic *value* round-tripping through `/V` says nothing about
whether an *appearance* renders — now works: a text field with `Жилищный вопрос` and
`updateFieldAppearances(ptSans)` produces a document that round-trips the value and carries a real
appearance stream.

Also established: an option group keeps its ASCII export value (`FOR`) while the label drawn beside
it is Cyrillic, so translation cannot disturb what the parser reads; PT Sans covers `Ё ё Й й Ъ ъ Ы ы
Э э Ю ю`, the three organ postfixes, `№ « » —`; and two identical builds come out byte-identical.

## Subsetting was rejected, and this is the one judgement call worth arguing with

Subset embedding costs 11 KB against 322 KB — a 30× difference, and it is **not** used. A subset
contains only the glyphs the issuer draws, which are its own labels. A PDF viewer regenerates a
field's appearance from the font named in that field's `/DA` when someone types into it, so a member
writing a theme whose letters are not among the labels' letters would see blanks or boxes where their
own text should be. The stored value would still be correct and the application would still work —
which is what makes it the worse failure: the form looks broken and the data is fine.

**That risk is reasoned, not observed.** Confirming it needs a real viewer, which nothing here has.
The safe option costs bytes and the risky one costs a member the ability to read their own form, so
the bytes win until someone opens a template in Acrobat. Issued templates are ~327 KB each.

## Changes

**`issueTemplate.ts`** — an operation to a pre-filled AcroForm. It signs nothing, reads no chain, and
writes no file; it returns bytes and the field names it wrote, so the caller records the operation
first and decides where the file goes. The test asserts that by parsing the module's **import
statements**.

**Assets are injected rather than imported**, and that turned out to be load-bearing rather than
tidy. Vite's `?inline` — the pattern `main.ts` uses for the window icon — resolves to a **data URL in
a build and to a path string under vitest**, confirmed by probe. An issuer that imported its own font
would therefore be untestable against the real file. The composition root owns that question; this
module takes three byte arrays.

**`templateLayout.ts`** — A4 geometry as named constants with reasons, plus a `PageCursor` that
breaks the page rather than drawing a field below the paper.

**`formLabels.ts`** — all 62 printed strings in one module, and **a slot with no Russian text yet is a
value, not a comment**. `pending('cast vote')` renders as `[cast vote]`: bracketed, impossible to
mistake for finished wording, and never blank, because a missing label on a printed form is worse
than an obvious placeholder — a member cannot tell the field is unexplained. `pendingLabels()`
enumerates what is left and a test asserts the count, so "which strings are unworded" is a question
the suite answers. 61 outstanding; the 62nd is «Заря», which the whitepaper already supplies.

**The round trip is now end to end through the real issuer:** issue → fill the fields as a member
would → parse → assemble → build, compared against all eleven `INTENT_SAMPLES`. And the property that
could not be true by construction — `USE_CASES.md` issuance row 5, the app's own output passing the
app's own ingestion checks — is now asserted for all eleven.

This also closes slice 1's "`IssuedOperation.context` has no real expected values" gap: issuance
produces the context, so the tamper check compares issuance's own rendering against itself, and a
test confirms a freshly issued and filled form warns about nothing.

## Four things this slice got wrong first

- **`reserve()` under-reserved what a row actually consumed.** `rowHeight()` summed to 36pt while the
  issuer advanced 42, so a page break could have split a label from its field — and every form with
  more than a few fields overflowed onto a second page. Both now derive from the same constants, and
  the receipt block became two columns because six one-line values read but never filled do not
  deserve six rows.
- **A test grepped the whole source for `/signer|wallet/i`** and failed on the word "signer" inside
  the comment explaining that there is no signer. It reads the import statements now.
- **A test grepped the bytes for `/CreationDate`.** pdf-lib saves with object streams on, so the info
  dictionary is compressed and a byte search finds nothing whether the date is there or not.
- **`updateMetadata` is an option on `create()`/`load()`, not on `save()`.** pdf-lib's constructor
  runs `updateInfoDict`, which unconditionally overwrites `ModDate` with `new Date()` and `Producer`
  with its own string. So the 2026 date the test reported came from **the test's own `load()`
  mutating the document it opened**, not from the issuer. A note claiming reproducibility had been
  passing by luck was written and then withdrawn: the issuer sets both dates explicitly after
  `create()`, so it was deterministic all along.

The last one is worth remembering beyond this slice: **any pdf-lib `load()` that inspects metadata
must pass `updateMetadata: false`**, or it reports the moment it ran.

## The layout is verified by observation, not by arithmetic

Two assertions replaced a comment that claimed a test existed:

- every widget's own rectangle lies inside the printable area, tolerance equal to the border width —
  `addToPage` inflates a rect by the stroke it draws, so a 0.75pt border sits 0.375pt outside the box
  and an 0.01 tolerance failed on exactly that while saying nothing about the layout;
- no two field boxes overlap, which is where the two-column receipt block is actually checked and
  which a page count cannot see.

## Evidence

```text
$ npm run typecheck
> tsc --noEmit
(no output — clean)

$ npm run lint
> eslint --ext .ts,.tsx .
(no output — clean)

$ npm test
> vitest run
 Test Files  49 passed (49)
      Tests  644 passed (644)
```

Up from 48 files / 623 tests. New: `issueTemplate` (21). One dependency added:
`@pdf-lib/fontkit@1.1.1`.

Eleven sample templates were emitted for review at
`…/scratchpad/templates/<OPERATION_TYPE>.pdf`, 326–330 KB each.

## Unverified

- **No template has been opened in a real PDF viewer.** Appearance streams are generated and
  structurally correct, and whether Acrobat, Chrome and Foxit render the Cyrillic — and what they do
  when a member types into a field — is exactly what the sample files are for. The subsetting decision
  above rests on this.
- **The wording is 61 placeholders.** Every template currently prints bracketed English. The layout
  was measured against those strings, and real Russian wording is longer — a label that wraps or
  collides is possible, and nothing wraps text today: a long label runs past the field rather than
  breaking. The two-column receipt row is the tightest spot.
- **`?inline` in a packaged build is unproven.** The issuer sidesteps it, but whoever wires the
  composition root inherits the question, and `main.ts` already relies on it for the window icon
  without ever having been run.
- **Receipt stamping will need the font again.** A receipt regenerated from stored form bytes has to
  draw its status into a document whose embedded font is already there; Phase 6 either re-embeds or
  reuses, and nothing here has tried.
- **Nothing persists an `operationRef`.** Issuance takes one and the caller is supposed to have
  recorded it first. That ordering is Phase 5's to enforce, and until it exists every issued form is
  bound to a record that does not exist.
- **Reproducibility is proven within one process.** Two calls in one test produce identical bytes;
  nothing has compared across processes, Node versions, or pdf-lib upgrades, which is what pinning a
  fixture would actually require.
- **Nothing is wired to the worker, IPC, or the renderer.** No file dialog, no button. `npm start` was
  not run; worker protocol stays at v2.
