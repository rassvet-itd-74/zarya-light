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
