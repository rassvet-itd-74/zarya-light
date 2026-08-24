# Implementation order

Use only when the repository does not already have a more advanced implementation. If a later phase is already built, start from current state.

## Current repository state

The app is an unmodified `electron-forge` Vite + TypeScript scaffold: `src/main.ts`, `src/preload.ts` (empty), `src/renderer.ts`, plus the two brand assets. No chain code, no form code, no persistence, no tests, no test runner, and no PDF library. The ABI is at `src/chain/abi/Zarya.abi.json`.

**Phase 0 is complete.** The Solidity source arrived on 2026-08-24 and closed every open question; the contract surface is in `CONTRACT.md` and the behaviors that surprised us are in `CONTRACT_DEFECTS.md`. Both halves of the product are specified — the contract by its source, the document format by us — so nothing below is blocked on external input.

What remains in `CONTRACT_DEFECTS.md` is absorbed by ordinary implementation and needs no decision up front: terminal classification for quorum-failed votings plus their local suppression (Phase 7, and Phase 5 for the storage column); region ordinals and the extended error registry (Phase 2); threshold configuration as one three-value operation (Phase 3); and recovering a voting's organ from creation events, which makes the event projection load-bearing earlier than it would otherwise be (Phase 2).

Two incompatible deployments exist, differing in `castVote`'s arity. Phase 2's identity check should verify the *interface*, not just that the address has code — a `castVote` arity probe is the cheapest discriminator, and getting it wrong surfaces as a failed vote rather than a startup error.

## Phase 1 — the hexagon, the skeleton, and a test runner

Establish the shape before there is code to misplace. `src/domain/`, `src/app/`, `src/adapters/` per `ARCHITECTURE.md`. The moment `src/domain/` exists the ESLint import guard applies, so the dependency direction is enforced from the first file rather than retrofitted.

Main/preload/renderer split; worker or service boundary; typed IPC; configuration and secret abstraction. Set `contextIsolation`, `nodeIntegration`, and `sandbox` explicitly. Make DevTools dev-only. No blockchain writes yet.

Add a test runner — every later phase assumes one exists.

Declare `Clock` and `IdGenerator` early even though little uses them yet. Both are cheap now and awkward to introduce once call sites have hard-coded wall-clock time and inline id generation.

## Phase 2 — chain read adapter and preflight

Ahead of the form layer because template pre-fill depends on these reads.

- Provider and chainId validation; contract code check.
- Organ resolution via `getPartyOrgan`, carrying the structured triple with `region` as an **enum ordinal**, validated against `getPartyOrganIdentifier` on every resolution.
- Reads: `isVotingActive`, `isVotingFinalized`, `hasVoted`, `isMember`, `getVotingResults`.
- `VotingCreated` event indexing with a persisted block cursor — the only source of `endTime`, and the same cursor the matrix coordinate index projects from.
- `OrganResolver` both directions, including the `bytes32` → label reverse table.
- Error decoding across the ABI's 16 errors **plus** `NoThemeSet`, `NoStatementSet`, `InvalidCategory`, and `Panic(0x11/0x12/0x32)`.
- A hand-written fragment for `ValueAdded`, which fires at the Zarya address but is absent from the ABI.
- Chairman-aware preflight: `isMember` against the Chairperson organ for UX, simulation for the decision.
- Tests against a local node or fixtures, keyed on a region whose ordinal and subject code differ.

## Phase 3 — intent model

- Typed allow-listed intent union: the eight `create*Voting` variants, `CastVote`, and explicit privileged `SetMinimumQuorum` / `SetMinimumApprovalPercentage` / `TransferChairmanship`.
- `ExecuteVoting` is **not** a form intent.
- Organ represented as a structured triple, not a label.
- Schema validation separate from normalization separate from chain preflight.
- Exhaustive intent-to-adapter mapping with a `never` check so a new variant cannot silently fall through.

## Phase 4 — PDF form schema, issuance, and ingestion

- Define the field-name schema and `schemaVersion` in one module all three directions import.
- Issuance: template generation from chain context, logo drawn, empty `zarya.receipt.*` fields present, `operationRef` persisted before the file is emitted, reproducible output.
- Ingestion: parse `zarya.input.*` only; recover app-authored context from storage; structural refusal for XFA, encryption, flattening, a populated receipt marker, unknown version or field.
- Round-trip test as the primary check: issue → fill programmatically → ingest → assert the intent matches.
- Hostile fixtures per `zarya-pdf-forms`.

Pick a library that never executes PDF JavaScript and never fetches remote resources. Generation and parsing may use different ones.

Receipt stamping arrives with the transaction queue in Phase 6, since it needs a confirmed transaction — but define the `zarya.receipt.*` fields here so templates carry them from the start. Retrofitting them later invalidates every already-issued form.

The **matrix reference report** also belongs here: it needs only Phase 2 reads plus a PDF library, and it is the document a voter reads before filling anything. It carries no form fields, so it adds nothing to the ingestion surface.

## Phase 5 — persistence

Schema and migrations; issued-template records keyed by `operationRef`; form hashes and semantic operation identity; batch and item states; dependency representation; event cursor; resume and re-import tests. Unique constraint on `(chainId, contractAddress, votingId)` for execution jobs.

Issuance depends on this to record an operation before emitting a file, so a minimal template record may need to land alongside Phase 4.

## Phase 6 — serialized transaction queue and receipt stamping

Signer abstraction; send/wait/receipt flow; nonce-safe sequential writes; crash-state reconciliation across the five crash windows. Optional signed outbox only after the basic lifecycle is stable.

Receipt stamping hangs off confirmation, never off broadcast. A reverted transaction is stamped too. Regeneration from stored form bytes plus the transaction record must work without a chain write.

## Phase 7 — executive reconciler

Discovery via the `VotingCreated` cursor; chain-time deadline checks; enqueue `executeVoting(votingId)` only. Startup, periodic, manual `Run now`, and reconnect all call one `reconcile()`.

## Phase 8 — batch engine

Batch as a first-class persisted object; validate the whole batch before the first write; partial submission; dependency DAG with cycle detection; resume and cancel.

## Phase 9 — UI

Form template buttons; form import and review including tamper disclosure; audit trail; privileged operation preview; executive status and `Run now`; error detail without secret exposure.

Per-organ and per-voting eligibility thresholds **cannot be displayed** — no getter exists. Do not design UI that assumes they can.

## Phase 10 — hardening

Deterministic local E2E; eligibility snapshot regression; Chairman cross-organ tests; approval boundary and zero-vote tests; process-kill recovery; hostile-PDF fixtures; opt-in Sepolia smoke test; security review.
