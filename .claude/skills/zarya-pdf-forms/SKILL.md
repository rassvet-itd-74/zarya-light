---
name: zarya-pdf-forms
description: Issue, ingest, and receipt Zarya PDF AcroForm documents — generating pre-filled templates the UI hands out, defining the field-name schema, parsing returned forms, and stamping confirmed transactions back onto the form as a watermarked receipt. Use for template generation, form field mapping, PDF parsing, receipt watermarks, hostile PDF handling, and form fixtures. This skill never sends a transaction.
---

# Zarya PDF AcroForms

The app owns all three directions: it **issues** templates, **ingests** filled forms, and **stamps** a receipt once a transaction confirms. They live in one skill because they share a single field-name schema, and a change to one is a change to all.

```text
chain state + user selection
  -> template spec -> AcroForm PDF (pre-filled, operationRef embedded, logo drawn)
  -> [human fills and returns it]
  -> ingest -> validate -> neutral parsed fields -> zarya-intents -> transaction
  -> on confirmation: fill zarya.receipt.* -> flatten -> receipt PDF
```

Hostile-input controls are in `__ai/references/INVARIANTS.md` under "Form trust boundary". Ingestion ends at a neutral parsed representation and must never call a chain library or construct calldata.

The matrix reference report is a fourth PDF the app produces, but it is **not** a form — no fields, no schema version, no ingestion path — so it lives in `zarya-matrix-report`. Ingestion rejects it automatically for lacking a recognised `schemaVersion`.

## IMPORTANT: a form the app issued is still untrusted on return

Owning the template does **not** make the returned file trustworthy. Anything in a PDF can be edited: field values, field names, the read-only flag, the document itself. A returned form is a *claim*, never a fact.

> On ingest, read **only** the fields a human is meant to fill. Recover every app-authored value from the local database using `operationRef` — never from the returned PDF.

So a tampered `votingId` or `contract` in the file cannot influence a transaction, because the code never reads those fields for their values. Compare them against the database copy to *detect* tampering and surface a warning, but never use the file's version.

Set the ReadOnly flag on app-authored fields for the user's benefit. Treat it as a hint, not a control.

## Field-name schema

Hierarchical AcroForm names, three namespaces with different trust levels:

```text
zarya.meta.schemaVersion     app-authored, read-only  — parser contract version
zarya.meta.operationRef      app-authored, read-only  — database lookup key
zarya.meta.operationType     app-authored, read-only  — intent variant
zarya.context.chainId        app-authored, read-only  — display and tamper check
zarya.context.contract       app-authored, read-only
zarya.context.organ          app-authored, read-only  — display label
zarya.context.votingId       app-authored, read-only
zarya.input.*                human-filled             — the only fields read for value
zarya.receipt.*              app-authored, empty until confirmation
```

`zarya.input.*` names are per operation type: `zarya.input.support` (radio `FOR`/`AGAINST`), `zarya.input.member`, `zarya.input.value`, `zarya.input.signer`, and so on.

Version the schema explicitly. A form carrying an unknown `schemaVersion` is rejected with a clear message, never parsed on a best-effort basis.

## Receipt fields carry the watermark

The watermark is a set of AcroForm fields present in every template and empty at issuance:

```text
zarya.receipt.txHash        the transaction hash
zarya.receipt.status        CONFIRMED or REVERTED
zarya.receipt.blockNumber
zarya.receipt.chainId
zarya.receipt.confirmedAt   chain block timestamp, not workstation time
zarya.receipt.signer
```

They sit in the app-authored namespace, so the existing rule already covers them: **ingestion never reads a `zarya.receipt.*` field for its value.** A user who types a plausible transaction hash there achieves nothing.

At receipt time the app **overwrites** every receipt field unconditionally from the transaction record. Never merge, never preserve what the user left there, never skip a field because it already looks filled.

A non-empty `zarya.receipt.txHash` on an *incoming* form is the re-import marker — a receipt coming back around, or a forgery attempt; both rejected rather than parsed.

Then flatten the receipt. Flattening bakes the field appearances into page content, so the stamp is permanent and the form cannot be refilled and resubmitted — and ingestion's flattened-form rejection catches it independently. Two mechanisms, neither relying on the other.

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

- **Field rotation is quantized to 90° steps** (`/MK /R` accepts 0, 90, 180, 270). A diagonal across-the-page watermark is therefore not achievable with fields alone — a horizontal band is. A diagonal stamp would have to be drawn page content, which means composing graphics rather than only setting field values.
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
- a user-filled `zarya.receipt.txHash` is overwritten, not preserved;
- a user-filled receipt field is never read for value during ingestion;
- re-importing a receipt is rejected by the `txHash` marker, and again by the flattened-form check with the marker removed — prove each independently;
- `REVERTED` status renders as clearly as `CONFIRMED`;
- an `executeVoting` receipt does not claim the proposal passed;
- the receipt is byte-reproducible from the stored form plus transaction record;
- no key material or seed phrase appears anywhere in the output.
