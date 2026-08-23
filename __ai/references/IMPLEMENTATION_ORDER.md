# Implementation order

Use only when the repository does not already have a more advanced implementation. If a later phase is already built, start from current state rather than following this order mechanically.

## Current repository state

The app is an unmodified `electron-forge` Vite + TypeScript scaffold: `src/main.ts`, `src/preload.ts` (empty), `src/renderer.ts`. No chain code, no form code, no persistence, no tests, no test runner, and no PDF library. The ABI is at `src/chain/abi/Zarya.abi.json`.

Phase 0 is largely complete — the contract surface is recorded in `CONTRACT.md`. What remains of it is the residual list below.

Both halves of the product are now specified: the contract by its ABI, the document format by us. Nothing below is blocked on external input.

## Phase 0 residue — resolve before writing chain code

Four questions the ABI could not answer. All four are in `DOCUMENTATION_STATUS.md` with the evidence that would close each.

1. **Region enum value versus subject code** — do this first and cheaply: `getPartyOrganIdentifier` is `pure`, so probing candidate values against the expected label costs one read. Every organ-addressed call depends on the answer.
2. **Rejection semantics** — does a failed voting revert or finalize? Determines the entire executor retry design.
3. **Chairman cross-organ `castVote`** — determines whether preflight may reject a non-member vote.
4. **Zero-vote execution** — the approval formula divides by `totalVotes`.

Items 2–4 need Solidity source or a live Sepolia read. Do not guess; a wrong assumption here produces an executor that misclassifies political outcomes as technical failures.

## Phase 1 — the hexagon, the skeleton, and a test runner

Establish the shape before there is code to misplace. `src/domain/`, `src/app/`, `src/adapters/` per `ARCHITECTURE.md`. The moment `src/domain/` exists the ESLint import guard applies, so the dependency direction is enforced from the first file rather than retrofitted.

Main/preload/renderer split; worker or service boundary; typed IPC; configuration and secret abstraction. Set `contextIsolation`, `nodeIntegration`, and `sandbox` explicitly. Make DevTools dev-only. No blockchain writes yet.

Add a test runner — every later phase assumes one exists, and the domain is testable with fakes from this phase onward.

Declare `Clock` and `IdGenerator` early even though little uses them yet. Both are cheap now and awkward to introduce once call sites have hard-coded `Date.now()` and inline id generation.

## Phase 2 — chain read adapter and preflight

Ahead of the form layer because template pre-fill depends on these reads: a template cannot carry authoritative context until the app can read that context.

- Provider and chainId validation; contract code check.
- Organ resolution via `getPartyOrgan`, carrying the structured triple.
- Reads: `isVotingActive`, `isVotingFinalized`, `hasVoted`, `isMember`, `getVotingResults`.
- `VotingCreated` event indexing with a persisted block cursor — the only source of `endTime`.
- Custom error decoding across all 16 errors.
- Chairman-aware preflight that simulates rather than pre-checking identity.
- Tests against a local node or fixtures.

## Phase 3 — intent model

- Typed allow-listed intent union: the eight `create*Voting` variants, `CastVote`, and explicit privileged `SetMinimumQuorum` / `SetMinimumApprovalPercentage` / `TransferChairmanship`.
- `ExecuteVoting` is **not** a form intent.
- Organ represented as a structured triple, not a label.
- Schema validation separate from normalization separate from chain preflight.
- Exhaustive intent-to-adapter mapping with a `never` check so a new variant cannot silently fall through.

## Phase 4 — PDF form schema, issuance, and ingestion

The app owns this format, so it can be built now — nothing here waits on an external spec.

- Define the field-name schema and `schemaVersion` in one module all three directions import.
- Issuance: template generation from chain context, logo drawn, empty `zarya.receipt.*` fields present, `operationRef` persisted before the file is emitted, reproducible output.
- Ingestion: parse `zarya.input.*` only; recover app-authored context from storage; structural refusal for XFA, encryption, flattening, a populated receipt marker, unknown version or field.
- Round-trip test as the primary check: issue → fill programmatically → ingest → assert the intent matches.
- Hostile fixtures per `zarya-pdf-forms`.

Pick a library that never executes PDF JavaScript and never fetches remote resources. Generation and parsing may use different ones.

Receipt stamping arrives with the transaction queue in Phase 6, since it needs a confirmed transaction to stamp — but define the `zarya.receipt.*` fields here so templates carry them from the start. Retrofitting them later invalidates every already-issued form.

## Phase 5 — persistence

Schema and migrations; issued-template records keyed by `operationRef`; form hashes and semantic operation identity; batch and item states; dependency representation; event cursor; resume and re-import tests. Unique constraint on `(chainId, contractAddress, votingId)` for execution jobs.

Issuance depends on this to record an operation before emitting a file, so a minimal template record may need to land alongside Phase 4.

## Phase 6 — serialized transaction queue and receipt stamping

Signer abstraction; send/wait/receipt flow; nonce-safe sequential writes; crash-state reconciliation across the five crash windows. Optional signed outbox only after the basic lifecycle is stable.

Receipt stamping hangs off confirmation here — never off broadcast. A reverted transaction is stamped too. Regeneration from stored form bytes plus the transaction record must work without a chain write.

## Phase 7 — executive reconciler

Discovery via the `VotingCreated` cursor; chain-time deadline checks; enqueue `executeVoting(votingId)` only. Startup, periodic, manual `Run now`, and reconnect all call one `reconcile()`. Outcome classification follows whatever Phase 0 item 2 established.

## Phase 8 — batch engine

Batch as a first-class persisted object; validate the whole batch before the first write; partial submission; dependency DAG with cycle detection; resume and cancel.

## Phase 9 — UI

Form template buttons; form import and review including tamper disclosure; audit trail; privileged operation preview; executive status and `Run now`; error detail without secret exposure.

Note that per-organ and per-voting eligibility thresholds **cannot be displayed** — no getter exists. Do not design UI that assumes they can.

## Phase 10 — hardening

Deterministic local E2E; eligibility snapshot regression; Chairman cross-organ tests; approval boundary and zero-vote tests; process-kill recovery; hostile-PDF fixtures; opt-in Sepolia smoke test; security review.
