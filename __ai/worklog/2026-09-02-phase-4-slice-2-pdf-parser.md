# Phase 4 slice 2 — the PDF library, the parser, and the hazard refusals

## Ask

"Move on to the next piece of work." Phase 4 slice 2: choose the PDF library and build the parsing
half. Issuance was deliberately left out — it needs an embedded Cyrillic font, a layout, and the
logo, none of which the parser needs, and the parser is the security-critical direction. `USE_CASES.md`
matrix-report row 10 already says "the **embedded** font covers the range", so the font is settled as
a requirement and is slice 3's asset work rather than an open question.

## The library was chosen by probing it

Three probe scripts against pdf-lib 1.17.1 before a line of the parser was written. Every claim in
the code comments comes from an observation:

| Constraint | Observed |
| --- | --- |
| never executes PDF JavaScript | `/OpenAction` with `/JS` and a `/Names` JavaScript tree both survive a load as inert dictionary entries; `eval` and `new Function` appear nowhere in the package |
| never fetches a remote resource | every `fetch(` in the source is inside a JSDoc example; **zero** non-comment occurrences |
| reads and writes AcroForm names and values | round-tripped, including `Жилищный вопрос` and a value stored as a hex string rather than a literal |
| fails loudly on a malformed file | throws on garbage, on an empty buffer, and on a truncated document |

`@cantoo/pdf-lib` — the maintained fork, pdf-lib itself being untouched since 2022 — was **rejected**.
It pulls an HTML parser in at `>=1.5.9`, an unpinned major range, plus `color` and `html-entities`,
for features this project does not use. That is dependency surface on the one boundary that parses
hostile input, against pdf-lib's four narrow dependencies and roughly 25× the weekly downloads. This
is a genuine trade — an unmaintained parser is a real cost — and the thing that makes it acceptable
is below.

**Two constraints pdf-lib does not meet**, recorded rather than glossed:

- **A corrupted `startxref` offset still loads.** It recovers by scanning for objects, which is
  exactly the "guessing" `zarya-pdf-forms` warns against. Tolerable because a recovered document is
  judged by the same rules as any other, and every app-authored value comes from the operation record
  no matter what the file says.
- **String decoding blows the stack on multi-megabyte values.** A 3 MB field value throws
  `RangeError: Maximum call stack size exceeded` during `load`. The 4 MiB file cap exists for this,
  not for tidiness, and the throw is caught and reported as unreadable.

## Changes

**`pdfFormParser.ts` — bytes to field values, with a deliberately narrow contract.** It never throws,
never runs anything, never fetches, and produces *only* names and values, so nothing downstream can be
steered by page content, an action, or an embedded file. It reports names the schema does not define,
because `assembleFormInput` is what judges vocabulary and it can only refuse what it is shown.

Eleven rejection codes, each observed working against a real file: `EMPTY`, `TOO_LARGE`, `UNREADABLE`,
`ENCRYPTED`, `XFA_PRESENT`, `NOT_A_FORM`, `FLATTENED`, `DUPLICATE_FIELD_NAME`, `TOO_MANY_FIELDS`,
`FIELD_VALUE_TOO_LONG`, `UNSUPPORTED_FIELD_TYPE`.

Four of those needed a decision rather than a check:

- **Encryption is detected by loading with `ignoreEncryption` and then testing `isEncrypted`**, not by
  catching pdf-lib's error. `EncryptedPDFError` does not survive the CJS build — `instanceof` is
  `false` and `error.name` is `'Error'` — so the alternative was matching an error message a patch
  release can reword. Nothing is read from the document between the load and the check.
- **`NOT_A_FORM` is checked on the catalog before `getForm()`**, because `getForm()` *creates* an
  AcroForm dictionary when none exists. Asking it first would make every PDF look like an empty form,
  including the matrix report.
- **`FLATTENED` is distinguishable from `NOT_A_FORM`** because flattening leaves the AcroForm
  dictionary in place with no fields behind it. So the message can say "this was flattened or printed
  and rescanned" rather than blaming a member for a blank field.
- **A duplicate field name is refused, and neither value is used.** pdf-lib returns both fields and
  its `getTextField` hands back the first; which one a viewer displays is not determinable from the
  file, so picking either would be inventing an answer.

**Unsupported field types are refused rather than read as blank.** No Zarya template contains a
checkbox, dropdown, or signature field, so one wearing a schema name is a rebuilt file — and reading
its value would mean deciding what a tick means as governance text.

## A finding that corrected slice 1

**A present-but-unfilled field reads `undefined` from pdf-lib, and slice 1 built a load-bearing
distinction on the difference between absent and blank:** absent means the field is gone and the form
is damaged, blank means a person did not fill it in, and `assembleFormInput` answers the two
differently — `MISSING_INPUT_FIELD` versus a per-field validation message. Passing `undefined`
through would have reported every legitimately blank form as flattened. The parser turns it into `''`,
and there is a test that says so.

That is the kind of mismatch that only shows up when the layer below arrives. Slice 1's design was
right; its assumption about the library was not checked, because there was no library.

## Fixtures, and why half of them are string literals

`testing/pdfFixtures.ts` builds the well-formed files with the library and writes the hostile ones by
hand. Nothing well-behaved emits a corrupted cross-reference table, a duplicate field name, or an
`/Encrypt` entry with no cipher behind it.

**This is explicitly not issuance.** It writes field names and values and nothing else: no logo, no
font, no layout, no `operationRef` persisted first, no reproducibility. Kept apart on purpose — a
parser test that leans on the issuer passes for the wrong reason once the issuer is wrong. Slice 3
replaces it and these fixtures become something to compare against.

The duplicate-name fixture took two attempts, and the reason is worth keeping: **pdf-lib stores a
dotted field name as a `/Parent` chain.** `zarya.input.member` is a node `zarya`, a node `input`, and
a leaf `member`, and `getName()` composes the chain back. Setting a decoy's `/T` to the full dotted
name produced `zarya.input.zarya.input.member` — a different field, not a duplicate. The collision has
to be forced at the **leaf**, under the same parent.

## The round trip is now real

`formRoundTrip.test.ts` runs PDF bytes → `parseFormFields` → `assembleFormInput` → `buildIntent` and
compares the result to the eleven `INTENT_SAMPLES` fixtures. The synchronous field-level path is kept
alongside it so a value-level question does not pay for a PDF round trip; both meet at
`assembleFormInput`. Cyrillic governance text survives two encodings and the parser unchanged, and the
vote direction comes from a radio group's export value.

## The library is confined by lint

A new `.eslintrc.json` override forbids `pdf-lib`, `pdfjs-dist`, `hummus` and `pdfkit` everywhere
under `src/` except `src/adapters/forms/`, with `src/domain/**` excluded because a second override of
the same rule replaces rather than merges and the domain's own list is wider. Verified both ways: a
temporary `pdf-lib` import in `adapters/chain/` errored with the intended message, and the forms
adapter stayed clean.

`viem` is **not** confined the same way, which is now an asymmetry. Left alone rather than fixed
unasked, since it is a separate change with its own risk of breaking an import.

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
 Test Files  48 passed (48)
      Tests  623 passed (623)

$ npm run ai:validate
AI package OK — 16 skills, 49 documents (18 worklog), 4658 lines,
71 ABI and 1187 source symbols cross-checked.
```

Up from 47 files / 598 tests. New: `pdfFormParser` (22), plus three tests added to `formRoundTrip`.
One dependency added: `pdf-lib@1.17.1`.

## Unverified

- **No PDF has been *written* by the application.** Issuance is slice 3, and with it the embedded
  Cyrillic font, the logo, the layout, reproducible byte-for-byte output, and the acceptance criterion
  that the app's own output passes its own ingestion checks. The fixture builder satisfies a weak
  version of that today.
- **Cyrillic *appearances* have never been rendered.** The fixtures save with
  `updateFieldAppearances: false`, which is what lets a Cyrillic value round-trip without a font — the
  value lives in `/V` and only the appearance needs glyphs. Whether pdf-lib can generate a readable
  Cyrillic appearance with an embedded TTF is exactly what slice 3 has to establish, and a probe
  showed `setText` with a Cyrillic string *saving* without error, which is not the same as rendering.
- **The appearance-versus-`/V` divergence is not surfaced.** The value is taken as authoritative,
  which is correct, and `zarya-pdf-forms` also asks for the divergence to be reported as a tamper
  signal. Detecting it means decoding a field's appearance content stream — more parsing of untrusted
  data than the signal is worth right now. Recorded as a gap, not implied as done.
- **Compression bombs are bounded, not solved.** The 4 MiB cap bounds the compressed input; a
  high-ratio object stream inside it can still inflate to much more, and nothing measures decompressed
  size. `INVARIANTS.md` also asks for bounds on object-graph depth and page count, and neither is
  implemented — field count and value length are.
- **`UNREADABLE` covers more than it should.** A truncated file, a non-PDF, and a value that defeats
  the library's stack all report the same code. A user seeing it cannot tell a damaged download from a
  hostile file.
- **No embedded-file or external-reference refusal.** `INVARIANTS.md` asks for rejection of external
  references, launch actions, and URI actions. Nothing here inspects them — the mitigation is that
  the parser reads only field names and values, so an action is never followed, but the file is not
  *refused* for carrying one and the app's own output has not been checked for cleanliness.
- **Nothing is wired to the worker, IPC, or the renderer.** No file dialog, no application service.
  `npm start` was not run; worker protocol stays at v2.
