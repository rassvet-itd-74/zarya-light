---
name: zarya-pdf-forms
description: Issue, ingest, and receipt Zarya PDF AcroForm documents — generating pre-filled templates the UI hands out, defining the field-name schema, parsing returned forms, and stamping confirmed transactions back onto the form as a drawn receipt stamp. Use for template generation, form field mapping, PDF parsing, receipt stamps, hostile PDF handling, and form fixtures. This skill never sends a transaction.
---

# Zarya PDF AcroForms

The app owns all three directions: it **issues** templates, **ingests** filled forms, and **stamps** a receipt once a transaction confirms. They live in one skill because they share a single field-name schema, and a change to one is a change to all.

```text
chain state + user selection
  -> template spec -> AcroForm PDF (pre-filled, operationRef embedded, logo drawn)
  -> [human fills and returns it]
  -> ingest -> validate -> neutral parsed fields -> zarya-intents -> transaction
  -> on confirmation: flatten -> draw the stamp over the page -> receipt PDF
```

Hostile-input controls are in `__ai/references/INVARIANTS.md` under "Form trust boundary". Ingestion ends at a neutral parsed representation and must never call a chain library or construct calldata.

The matrix reference report is a fourth PDF the app produces, but it is **not** a form — no fields, no schema version, no ingestion path — so it lives in `zarya-matrix-report`. Ingestion rejects it automatically for lacking a recognised `schemaVersion`.

## IMPORTANT: a form the app issued is still untrusted on return

Owning the template does **not** make the returned file trustworthy. Anything in a PDF can be edited: field values, field names, the read-only flag, the document itself. A returned form is a *claim*, never a fact.

> On ingest, read **only** the fields a human is meant to fill. Recover every app-authored value from the local database using `operationRef` — never from the returned PDF.

So a tampered `votingId` or `contract` in the file cannot influence a transaction, because the code never reads those fields for their values. Compare them against the database copy to *detect* tampering and surface a warning, but never use the file's version.

There are no app-authored fields left to flag ReadOnly except the three `zarya.meta.*`, which are 1pt widgets a member never sees. The advisory flag was never the control; now there is nothing for it to advise about.

## Field-name schema

Hierarchical AcroForm names. **Two namespaces are fields; two are names kept only to refuse them.**

```text
zarya.meta.schemaVersion     FIELD, app-authored  — parser contract version
zarya.meta.operationRef      FIELD, app-authored  — database lookup key
zarya.meta.operationType     FIELD, app-authored  — intent variant
zarya.input.*                FIELD, human-filled  — the only fields read for value

zarya.context.*              NOT a field. Printed on the page as text.
zarya.receipt.*              NOT a field. Names what the stamp states.
```

Since 2026-09-06 (`zarya.form.2`), **every widget on an issued form is one a member is meant to write in.** The application block used to be shaded read-only text fields and the receipt six empty ones; a member looking at a page of boxes could not tell which were theirs, and the ReadOnly flag is advisory — it stops a viewer, not a person with any other tool. Drawing them as text makes the trust rule visible instead of merely stated.

The two retired names survive in the schema so a file carrying one can be **named** in its refusal (`RETIRED_FIELD`) rather than met with a generic "unknown field". "This field used to exist here" and "no such field has ever existed" are different facts about a document.

`zarya.input.*` names are per operation type: `zarya.input.support` (radio `FOR`/`AGAINST`), `zarya.input.member`, `zarya.input.value`, `zarya.input.signer`, and so on.

Version the schema explicitly. A form carrying an unknown `schemaVersion` is rejected with a clear message, never parsed on a best-effort basis.

## The receipt is a stamp, not fields

Six facts, named by the retired `zarya.receipt.*` keys and drawn as ink:

```text
zarya.receipt.txHash        the transaction hash
zarya.receipt.status        SUCCESS or REVERTED
zarya.receipt.blockNumber
zarya.receipt.chainId
zarya.receipt.confirmedAt   chain block timestamp, not workstation time
zarya.receipt.signer
```

**Flatten first, then stamp.** Flattening appends the field appearances to the page's content stream, so a stamp drawn before it would end up underneath the very values it is stamping. Flattening is also what stops a receipt being refilled and resubmitted, and ingestion's flattened-form rejection catches a re-import independently of the `RETIRED_FIELD` refusal. Two mechanisms, neither relying on the other.

**The stamp overprints.** It is applied over the returned page the way a rubber stamp is applied to paper: nothing is reserved for it, the template is not laid out around it, and no page is added. Its interior is an **opaque ground** so the six facts stay readable over whatever they cover — a receipt whose transaction hash cannot be transcribed is not a receipt — while the frame lands directly on page content.

**Geometry lives in one place.** `drawSvgPath` understands path data and nothing else — no `<rect>`, no `<text>` — so the mark comes from the asset and the facts are drawn text, and the only thing joining them is a shared coordinate table (`receiptStampArt.ts`). A rule moved in the asset while an offset stays in code looks right in both files and wrong on paper.

**The hash sizes the stamp.** 66 characters at 8pt is the widest thing it will ever hold and nothing wraps, so it gets a full-width band to itself. Measure in the embedded font; do not estimate.

## Bound and unbound forms

- **Bound** — issued against a recorded operation, `operationRef` present. Authoritative context comes from the database. This is the normal path and the one the UI buttons produce.
- **Unbound** — a generic blank form with no `operationRef`. Every value is user-supplied, so it needs full schema validation plus chain preflight, and it cannot benefit from the tamper check. Support it only if the product requires it, and never treat it as equivalent to a bound form.

## Issuance

Generating a template is a write to the user's filesystem, not to the chain. It must not require a signer.

- Derive pre-filled context from chain reads and the user's selection, then **persist the operation and its `operationRef` before handing over the file**. An issued form whose reference is not recorded is unbound in practice.
- Pre-fill display values as text; do not encode structured data in a way the human is expected not to disturb.
- Embed no JavaScript, no actions, no embedded files, and no external references — the app's own output should pass its own ingestion checks.
- Generated templates are reproducible: same operation and schema version in, byte-comparable form out, so a fixture can pin them.

Round-trip is the strongest available test: issue a template, fill it programmatically, ingest it, and assert the recovered intent matches the operation that produced it.

## Ingestion

Parse only what the schema names. Specific PDF hazards that need explicit handling:

- **XFA** — a dynamic-form PDF can carry XFA data that shadows the AcroForm values, so two readers disagree about what the form says. Reject any PDF containing XFA rather than choosing a winner.
- **Flattened forms** — flattening turns fields into page content and destroys the data. Detect the absence of the expected fields and say so, rather than reporting an empty form.
- **Incremental updates** — a PDF can hold several revisions, and earlier field values remain in the file. Resolve effective values consistently through one library's object model; never scrape raw bytes.
- **Duplicate field names** — AcroForm siblings can share one value. Decide the rule and test it.
- **Encryption** — reject an encrypted or password-protected form with a clear message.
- **Appearance streams** — a field's visible appearance can disagree with its `/V` value. The value is authoritative; if they diverge, that is a tamper signal worth surfacing.

## Receipt emission

**Stamp on confirmation, not on broadcast.** A broadcast transaction can still revert, be replaced, or be dropped, and a form stamped "sent" is a record that may become false after someone printed it. Emit the receipt when the transaction confirms and put the outcome in `zarya.receipt.status`. A broadcast-time artifact, if genuinely wanted, must say `PENDING` and be superseded.

**A confirmed transaction is not an accepted proposal.** `status = CONFIRMED` means the call succeeded. For `castVote` that means the vote was recorded; for `executeVoting` it does **not** mean the proposal passed — the governance result is the `success` flag on `VotingFinalized`. Keep the two as separate statements on the page. A quorum-failed execution does not confirm at all: it reverts permanently (see "Quorum failure is permanent" in `__ai/references/CONTRACT_DEFECTS.md`), and a reverted transaction is still stamped.

**The watermark is not a security control.** Anyone can add a watermark, a hash, and a logo to any PDF. The chain is the only verification.

**Reproducible, not authoritative.** A receipt is a rendering of the returned form plus the transaction record, both already stored. If one is lost, regenerate it. Never parse a receipt to recover data the database already holds.

### Layout constraints

- **Field rotation is quantized to 90° steps** (`/MK /R` accepts 0, 90, 180, 270), which is one reason the receipt is composed graphics rather than fields: nothing that reads as a stamp was achievable with widgets.
- **The logo cannot live in a text field.** Draw it at issuance so every template and receipt carries it. A pushbutton's icon (`/MK /I`) is the field-based alternative. Asset formats and the DPI caveat are in `__ai/references/DEPLOYMENT.md`.

### Batch behavior

A batch produces many receipts. Write them to one per-batch directory rather than opening a save dialog per form, and name them from `operationRef` plus transaction hash so a file is traceable without opening it.

## Library constraints

No library is installed yet. Whatever is chosen must:

- never execute PDF JavaScript — `/JS`, `/OpenAction`, and `/AA` are read as data or ignored, never run;
- never fetch a remote resource while parsing;
- allow reading AcroForm field names and values, and writing them for issuance;
- fail loudly on a malformed cross-reference table rather than guessing.

Generation and parsing may use different libraries if that keeps the parser narrower.

## Determinism

- Normalize whitespace deliberately and test the normalization.
- Never fuzzy-match a field name. An unknown name is an error, not a near-miss to resolve.
- Never infer vote direction from free text — it comes from an explicit radio value.
- Never silently coerce a malformed address or number.
- Fixed-point normalization belongs in the intent layer.
- Organ labels parse to a structured triple, not a hashed string — see `zarya-intents`. Expect Cyrillic (`СЗД`, `ПРЛ`, `74.СОВ`) and handle it as UTF-8 throughout, including in generated field values.

## Fixtures

**Issuance and ingestion:** a generated template pinned byte-for-byte; a filled round-trip; and hostile inputs — missing field, unknown `schemaVersion`, unknown field name, malformed value, flattened form, XFA present, encrypted, embedded JavaScript, embedded file, external reference, corrupted xref, compression bomb, oversized field value, duplicate field names, incremental-update shadowing, appearance disagreeing with `/V`, `operationRef` absent, and `operationRef` pointing at an unknown or already-completed operation.

**Receipts:**
- every fact is found in the page's content stream, in glyph space — a fact that stopped being drawn leaves no field behind to miss it;
- the transaction hash fits its band, measured in the embedded font at the drawn size;
- the asset's rules sit at exactly the band edges the text is placed from;
- a `zarya.receipt.*` field on an incoming form is refused whether filled or empty;
- re-importing a receipt is rejected by the flattened-form check, and again as `RETIRED_FIELD` if someone rebuilds the fields — prove each independently;
- `REVERTED` status renders as clearly as `CONFIRMED`;
- an `executeVoting` receipt does not claim the proposal passed;
- the receipt is byte-reproducible from the stored form plus transaction record;
- no key material or seed phrase appears anywhere in the output.
