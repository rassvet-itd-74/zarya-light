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

## Matrix reference report

- A UI button prints a read-only PDF listing the matrix contents, so voters can find the coordinates to write on a form. No signer, no chain write.
- It is **not** an AcroForm: no fields, no `schemaVersion`, no `operationRef`. It therefore cannot re-enter the form pipeline, and ingestion rejects it without a special case.
- The contract exposes no matrix dimensions and no cell enumeration, so the coordinate index is projected from events. `ValueAdded` and `CategoryAdded` fire on application and need no gating; themes, statements, and decimals emit nothing on application, so their creation events are gated on `VotingFinalized(success = true)`. The projection is complete because matrix state changes only through a successful voting.
- The projection reuses the executor's event cursor. No second sweep.
- Organ labels need a locally built `bytes32` → label reverse table, since only the triple → `bytes32` direction has a getter. Both helpers are `pure`, so the table is cached permanently, and it is keyed by region **enum ordinal**.
- A matrix with axes but no populated cells is a valid report, not an error — expected while the matrix is young. The report never lists merely *proposed* coordinates to look fuller: a coordinate that does not exist is one a voter cannot use.
- Every page carries the block number and chain timestamp it was read at. A report is a snapshot, never authoritative; preflight validating coordinates at submission is the safety net for a stale printout.

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
- Theme and statement votings use `simpleMajority`, and are **open votes**: no organ, so `castVote` applies no membership check and any address may vote. Intentional. Note the consequence — with a quorum of 1, one address can create, vote, and execute a theme voting alone.
- Eligibility is expressed in **basis points** (`simpleMajority` is `{1, 5000, 10000}`). The client preserves the contract's unit and never normalizes to percent; an approval figure is rendered against its own base or not at all.
- Threshold configuration is one operation carrying all three values. The base doubles as an enable flag, so setting quorum alone changes nothing (`CONTRACT_DEFECTS.md`).
- Approval comparison semantics are contract behavior, read from source and tested — never reinterpreted client-side.
- Effective thresholds cannot be displayed in UI, and a configuration write cannot be read back. No getter exists for organ or per-voting eligibility.
- A rejected voting is a governance outcome, never a fault condition. Executor health must not treat a rejection rate as degradation.

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

When `temporal_docs/` prose and the code disagree: do not guess, prefer the code, report the mismatch, and record it in `DOCUMENTATION_STATUS.md`. If the user is asking for documented target behavior that the contract lacks, say so before implementing anything that assumes it.

The contract's actual behavior is read from `temporal_docs/Zarya.sol` and its libraries, which match the ABI's external surface. Deployed bytecode is the final authority, so a claim read from source is reported as read from source.

Never reconcile a defect by making the client behave as though the contract were correct. Report what the chain did.
