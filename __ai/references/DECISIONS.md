# Locked decisions

Product and architecture choices that are settled. Change them only when the user explicitly changes the requirement, or when repository evidence proves an assumption obsolete.

These are *decisions*, not invariants. For rules that hold unconditionally, see `INVARIANTS.md`. For network and address, `DEPLOYMENT.md`. For contract facts, `CONTRACT.md`.

## Documents are PDF AcroForms the app issues

- The UI hands out pre-filled templates through per-operation buttons. The user fills a form and returns it; the app ingests it.
- The app owns the field-name schema, versioned by `zarya.meta.schemaVersion`. See `zarya-pdf-forms`.
- Issuance persists the operation and its `operationRef` **before** the file is handed over. An issued form whose reference was never recorded is unbound in practice.
- A returned form is untrusted. Human-filled `zarya.input.*` fields are read for value; app-authored context is recovered from local storage via `operationRef` and the file's copy is used only to detect tampering.
- Unbound forms — no `operationRef` — are supported only if the product requires them, and never treated as equivalent to bound forms.
- Issuance is a filesystem write. It requires no signer and touches no chain write path.

## Receipts

- When a transaction confirms, the returned form is stamped into a receipt: `zarya.receipt.*` fields filled from the transaction record, then flattened.
- The watermark is carried by AcroForm fields present in every template and empty at issuance — not by composed graphics. Field rotation is quantized to 90° steps, so the mark is a horizontal band rather than a diagonal.
- Receipt fields are overwritten unconditionally. A user may type into them; the value is replaced, and ingestion never reads them for value.
- Stamping happens on confirmation, never on broadcast. A reverted transaction is still stamped, with `status = REVERTED`. No receipt means the outcome is unknown, not that it failed.
- A receipt is a rendering of stored data and is regenerable without a chain write. The PDF is disposable output; the form bytes and transaction record are the state.
- The watermark is not a security control. Verification is the chain.
- The Zarya logo is drawn onto templates and receipts from `src/assets/logo.png`. `favicon.ico` cannot be embedded in a PDF and is the window, HTML, and installer icon only.

## Scope of form-driven action

- Proposal creation and `castVote` originate from a returned form.
- `setMinimumQuorum`, `setMinimumApprovalPercentage`, and `transferChairmanship` may be form-driven, but only through explicit allow-listed intent variants — never inferred from text appearing in a field.
- `executeVoting` is never a form intent. It is derived from chain state.

## Voting eligibility

- The client never chooses quorum or approval values. `executeVoting` accepts none.
- Organ configuration is snapshotted into the voting at creation; a later threshold change does not affect an existing voting.
- Theme and statement votings use `simpleMajority`.
- Approval comparison semantics are contract behavior, verified against source and tested — never reinterpreted client-side.
- Effective thresholds cannot be displayed in UI. No getter exists for organ or per-voting eligibility.

## Bulk behavior

- A user may import one file, many files, or a directory.
- Parse and structurally validate the **entire** batch before the first write transaction.
- Invalid forms do not invalidate independent valid forms. Partial submission is allowed, and `PARTIAL` is a normal terminal state.
- One logical intent maps to one transaction. No write multicall in the initial implementation.
- Batch state is resumable across application restarts.
- Semantic conflicts — same signer and voting, opposite direction — are surfaced for user action, never resolved by import order.

## Form semantics

- Forms map only to an allow-listed typed intent union.
- Vote direction comes from an explicit field value, never inferred from text.
- An unknown `schemaVersion` or an unknown field name is an error, never a near-miss to resolve.
- Generated templates are reproducible, so a fixture can pin them and round-trip tests can prove issuance and ingestion agree.

## Chain and persistence

- On-chain state is authoritative for governance state and completed effects; local persistence is a durable job and audit cache.
- Recovery is reconciliation-driven. A mined transaction followed by a local crash is repairable by reading receipt and domain state.
- Voting discovery indexes `VotingCreated` with a persisted block cursor — `endTime` is available nowhere else.

## Executive operation UX

- One compact health indicator plus one manual action.
- `Run now` means reconcile now, not execute a user-selected voting. It is safe to press repeatedly.
- Top-level states: healthy, working, degraded, stopped. Counts may expose waiting, ready, pending, failed.
- Health is not job state. A political outcome must never be presented as an RPC, signing, or executor failure.

## Wallets

- Member wallet signs form-driven proposal, vote, and privileged configuration transactions.
- A separate minimally privileged executor wallet signs `executeVoting`, which is permissionless in the ABI.

## Documentation mismatch policy

When `temporal_docs/` and the ABI disagree: do not guess, prefer the ABI, report the mismatch, and record it in `DOCUMENTATION_STATUS.md`. If the user is asking for documented target behavior that the contract lacks, say so before implementing anything that assumes it.
