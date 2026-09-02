# Locked decisions

Product and architecture choices that are settled. Change them only when the user explicitly changes the requirement, or when repository evidence proves an assumption obsolete.

These are *decisions*, not invariants — rules that hold unconditionally are in `INVARIANTS.md`, network and address in `DEPLOYMENT.md`, contract facts in `CONTRACT.md`.

## Documents are PDF AcroForms the app issues

- The UI hands out pre-filled templates through per-operation buttons. The user fills a form and returns it; the app ingests it.
- The app owns the field-name schema, versioned by `zarya.meta.schemaVersion`. See `zarya-pdf-forms`.
- Issuance persists the operation and its `operationRef` **before** the file is handed over. An issued form whose reference was never recorded is unbound in practice.
- Unbound forms — no `operationRef` — are supported only if the product requires them, and never treated as equivalent to bound forms.
- Issuance is a filesystem write. It requires no signer and touches no chain write path.
- Generated templates are reproducible, so a fixture can pin them and round-trip tests can prove issuance and ingestion agree.

## The PDF library is pdf-lib 1.17.1 — decided 2026-09-02

Chosen by probing the package, not by reading its README. What was observed: `/OpenAction` with `/JS` survives a load as inert data and the package contains no interpreter, `eval`, or `new Function`; every `fetch` in its source is inside a JSDoc example and there are zero runtime occurrences; AcroForm names and values round-trip including Cyrillic and hex-encoded strings; and it throws on garbage, on an empty buffer, and on a truncated document.

`@cantoo/pdf-lib`, the maintained fork, was rejected despite pdf-lib being unmaintained since 2022. The fork pulls in an HTML parser at `>=1.5.9` — an unpinned major range — plus `color` and `html-entities`, for features this project does not use. That is dependency surface on the one boundary that parses hostile input, and pdf-lib has four narrow dependencies and roughly 25 times the weekly downloads.

Two ways pdf-lib does not meet the stated library constraints, both accepted with mitigations rather than hidden:

- **A corrupted `startxref` offset still loads.** It recovers by scanning rather than failing, which is the "guessing" `zarya-pdf-forms` warns against. Tolerable because a recovered document is judged by the same rules as any other, and every app-authored value comes from the operation record regardless of what the file says.
- **String decoding blows the stack on multi-megabyte values.** A 3 MB field value throws `RangeError` during `load`. The parser reports it as unreadable, and the 4 MiB file cap exists for this rather than for tidiness.

Only `src/adapters/forms/` may import it, enforced by ESLint and observed firing. Nothing else in the client parses a document.

## Templates are generated, in Russian, on A4 — decided 2026-09-02

- **The application generates every template.** A hand-prepared PDF filled in by the app was considered and rejected: it becomes an untracked binary whose field names nothing can check against `FIELD_PLAN`, and the reproducibility decision above turns into pinning someone's file rather than the issuer's output.
- **PT Sans, embedded whole rather than subset.** `src/assets/pt-sans/`, OFL. pdf-lib's standard fonts are WinAnsi and throw `WinAnsi cannot encode "С"`, so an embedded font is required. Subsetting would cost 11 KB against 322 KB, and is **not** used: a subset carries only the glyphs the issuer draws, and a viewer regenerating a field's appearance from it would show a member blanks where their own Cyrillic should be — a form that looks broken while the data is correct. Reasoned, not observed; revisit only after checking a template in a real viewer.
- **A4**, and **Russian only** on every printed string.
- **Printed wording lives in one module** (`formLabels.ts`) as values, and a slot with no Russian text yet renders bracketed rather than blank — a missing label is worse than an obvious placeholder, because a member cannot tell the field is unexplained. `pendingLabels()` enumerates what is outstanding so the suite reports it instead of anyone remembering.
- **Option groups keep ASCII export values.** `FOR`, `AGAINST`, `CATEGORICAL`, `NUMERICAL` are what the parser reads; only the text drawn beside the box is translated. Translating an export value is a form schema change.
- **Assets are injected into the issuer as bytes, never imported by it.** Vite's `?inline` resolves to a data URL in a build and to a *path string* under vitest, so an issuer that imported its own font could not be tested against the real file.
- **A form states that coordinates come from the matrix reference report** and are checked again at submission, on every template that asks for one.

Two facts about the library that shape the code above it: a dotted field name is stored as a `/Parent` chain and composed back by pdf-lib's name accessor, so `zarya.input.member` is a node tree rather than a flat string; and a present-but-unfilled field reads as `undefined`, which the parser must turn into a blank rather than an absence.

## Local storage is `node:sqlite`, owned by the worker — decided 2026-09-02

Chosen by running Electron, not by reading release notes: **Electron 43.4.1 bundles Node 24.18.1**, and a probe created a table, inserted a row, and read it back inside a real Electron main process.

`better-sqlite3` was rejected on build cost rather than on merit. It is a native module, so it needs an ABI rebuild against Electron's Node, a second build for the Node that runs the tests, and `plugin-auto-unpack-natives` in the packaged app. `node:sqlite` is in both runtimes already — nothing to compile, nothing to unpack, one API in tests and in production.

Accepted costs, recorded rather than buried:

- It is **experimental**. Node 22 emits an `ExperimentalWarning` and the API may change. Only `DatabaseSync`, `exec`, and `prepare`/`get`/`all`/`run` are used — the part any SQLite binding has — and the whole surface sits behind two ports, so a swap is two files.
- **Version skew.** Tests run on the Node that runs vitest; production runs on Electron's Node 24.18. The same module name in two runtimes is not the same guarantee as the same module. It is still better than needing two compiled binaries.

- **The worker owns the database; the main process never opens it.** `ARCHITECTURE.md` already places the transaction queue, reconciliation, and form work in the worker. A second handle in main would mean two processes writing one file for no gain, so UI status travels over the worker protocol instead.
- **Only `src/adapters/store/` may import a database driver**, enforced by ESLint and observed firing from three other directories.
- **Migrations are an append-only list keyed on `PRAGMA user_version`.** An existing entry is never edited — a database in the field has already run it. A schema from a newer build is refused, never migrated downwards.
- **Block numbers are stored as TEXT.** `node:sqlite` returns an INTEGER column as a JavaScript `number`, which is exact for Sepolia's eleven million and silently wrong past 2^53.
- **A returned form binds only against a record from the same deployment.** Nothing downstream reads the chain id or contract from the file, so the record is the sole authority on which deployment an operation belongs to, and two incompatible deployments exist.

## Matrix reference report

- A UI button prints a read-only PDF listing the matrix contents, so voters can find the coordinates to write on a form. No signer, no chain write.
- It is **not** an AcroForm: no fields, no `schemaVersion`, no `operationRef`. It therefore cannot re-enter the form pipeline, and ingestion rejects it without a special case.
- The coordinate index is projected from events and reuses the executor's cursor. No second sweep.
- A matrix with axes but no populated cells is a valid report, not an error. The report never lists merely *proposed* coordinates to look fuller: a coordinate that does not exist is one a voter cannot use.
- Every page carries the block number and chain timestamp it was read at. A report is a snapshot, never authoritative; preflight validating coordinates at submission is the safety net for a stale printout.

## Receipts

- When a transaction confirms, the returned form is stamped: `zarya.receipt.*` fields filled from the transaction record, then flattened.
- The watermark is carried by AcroForm fields present in every template and empty at issuance — not by composed graphics. Field rotation is quantized to 90° steps, so the mark is a horizontal band rather than a diagonal.
- A receipt is a rendering of stored data and is regenerable without a chain write. The PDF is disposable output; the form bytes and transaction record are the state.
- The Zarya logo is drawn onto templates and receipts from `src/assets/logo.png`. `favicon.ico` cannot be embedded in a PDF and is the window, HTML, and installer icon only.

## Scope of form-driven action

- Proposal creation and `castVote` originate from a returned form.
- `setMinimumQuorum`, `setMinimumApprovalPercentage`, and `transferChairmanship` may be form-driven, but only through explicit allow-listed intent variants — never inferred from text appearing in a field.
- `executeVoting` is never a form intent. It is derived from chain state.
- Vote direction comes from an explicit field value, never inferred from text.
- An unknown `schemaVersion` or an unknown field name is an error, never a near-miss to resolve.

## Voting eligibility

- The client never chooses quorum or approval values.
- Theme and statement votings are **open votes**: no organ, so any address may vote. Intentional — with a quorum of 1, one address can create, vote, and execute a theme voting alone.
- Eligibility is expressed in **basis points**. The client preserves the contract's unit and never normalizes to percent; an approval figure is rendered against its own base or not at all.
- Threshold configuration is one operation carrying all three values, because the base doubles as an enable flag (`CONTRACT_DEFECTS.md`).
- Approval comparison semantics are contract behavior, read from source and tested — never reinterpreted client-side.
- Effective thresholds cannot be displayed in UI, and a configuration write cannot be read back. No getter exists.
- A rejected voting is a governance outcome, never a fault condition. Executor health must not treat a rejection rate as degradation.

## Bulk behavior

- A user may import one file, many files, or a directory.
- Parse and structurally validate the **entire** batch before the first write transaction.
- Invalid forms do not invalidate independent valid forms. Partial submission is allowed, and `PARTIAL` is a normal terminal state.
- One logical intent maps to one transaction. No write multicall in the initial implementation.
- Batch state is resumable across application restarts.
- Semantic conflicts — same signer and voting, opposite direction — are surfaced for user action, never resolved by import order.

## Executive operation UX

- One compact health indicator plus one manual action.
- `Run now` means reconcile now, not execute a user-selected voting. It is safe to press repeatedly.
- Top-level states: healthy, working, degraded, stopped. Counts may expose waiting, ready, pending, failed.
- Health is not job state. A political outcome must never be presented as an RPC, signing, or executor failure.

## Wallets

- Member wallet signs form-driven proposal, vote, and privileged configuration transactions.
- A separate minimally privileged executor wallet signs `executeVoting`.
- An EOA's private key is **generated once and stored encrypted at rest** in a keystore file, rather than read from an environment variable on every start. `temporal_docs/keystore.json` is the working example and currently holds a **testing** key.
- The file is `{ salt, iv, tag, ciphertext }` — an AEAD envelope, so decryption is authenticated and a tampered file fails rather than yielding garbage. The KDF parameters behind `salt` are not recorded anywhere yet; **Phase 6 must pin them before it writes a reader**, because a keystore whose derivation is only implied by the code that wrote it cannot be re-opened by anything else.
- Key material never enters the repository, encrypted or not, and never enters the renderer, the logs, or the database. `.gitignore` covers `keystore.json`, `*.key`, and `.env*` so a test key cannot become a committed habit.
- `PublicConfig` reports **presence only** — `memberSignerConfigured` / `executorSignerConfigured` — never a path, an address derived from the key, or any part of the material.

## Documentation mismatch policy

When `temporal_docs/` prose and the code disagree: do not guess, prefer the code, report the mismatch, and record it in `DOCUMENTATION_STATUS.md`. If the user is asking for documented target behavior that the contract lacks, say so before implementing anything that assumes it.

Never reconcile a defect by making the client behave as though the contract were correct. Report what the chain did.
