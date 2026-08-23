---
name: zarya-testing
description: Design and implement tests for the Zarya Electron, PDF form, and Sepolia workflow — unit, integration, contract, local-chain, eligibility snapshots, Chairman authorization, persistence recovery, form round trips, hostile PDFs, queue, executor, IPC, and end-to-end. Prefer deterministic local tests; ordinary checks must never depend on Sepolia.
---

# Zarya testing strategy

> **No test runner is installed.** `package.json` has `typecheck` and `lint` only. Adding a runner is part of the first slice that needs tests — pick one that fits Vite and Electron rather than introducing a second toolchain.

Read `__ai/references/DOCUMENTATION_STATUS.md` before testing governance semantics: several expected behaviors are unverified, so a test asserting them would encode a guess as a requirement.

## Unit

Test pure domain logic aggressively — it needs no chain and no runner beyond the basics:

- form field normalization and schema-version handling
- intent schemas, including privileged configuration variants
- **organ triple → `bytes32` resolution**, and the region-encoding question specifically
- semantic identity and conflict keys
- state transitions
- dependency DAG and cycle detection
- executor candidate classification
- custom-error classification across all 16 errors

## Contract

Requires Solidity source, which this repository lacks. See `zarya-solidity-governance` for the invariants and the required cases.

## Integration

Against a deterministic local node, once chain code exists:

- ABI adapter against `src/chain/abi/Zarya.abi.json`
- create, cast, and execute flows
- privileged setter intents with correct and incorrect signers
- Chairman-aware preflight — including that it does **not** block a cross-organ vote
- receipt and event decoding, including `VotingCreated` cursor advancement
- executor race and already-finalized handling
- thresholds changed after voting creation
- preflight state races

Use real temporary storage for migration and crash-recovery tests.

## Assert what is proven, flag what is not

Where behavior is unverified, write the test so it *documents the uncertainty* rather than asserting a guess:

- **Rejection semantics** — a test that pins `FINALIZED_REJECTED` would encode an unverified assumption. Instead assert what must hold either way: `InsufficientVotes` is never classified retryable, and the executor does not loop on it.
- **Chairman cross-organ** — assert that preflight does not reject the vote, not that the contract accepts it.
- **Zero-vote** — assert the executor handles both a revert and a finalization without corrupting job state.

## Recovery

Inject failure at each boundary: state persisted before send; send returning or throwing ambiguously; transaction mined before the local update; RPC unavailable while pending; a second client finalizing first.

## Electron boundary

Test preload and main IPC contracts and worker supervision without rendering UI for every case.

## End-to-end

A few critical journeys: bulk import → review → submit → receipts; mixed valid and invalid batch; already-voted and expired casts; privileged threshold change with correct and incorrect signer; kill and restart with a pending transaction; overdue voting → automatic `executeVoting`; threshold change while an old voting is open; manual `Run now` sharing reconciliation; worker crash and restart; duplicate re-import.

Add the full form cycle to this list: issue a template, fill it programmatically, ingest it, submit against a local chain, confirm, and assert the stamped receipt carries the right hash and status. It is the highest-value single test in the product, because it covers issuance, the schema, ingestion, and stamping at once. See `zarya-pdf-forms`.

Then prove the receipt cannot re-enter the pipeline: feed the stamped output back to ingestion and assert rejection, both via the `zarya.receipt.txHash` marker and — with that marker stripped — via the flattened-form check.

## Network policy

CI and ordinary tests must never require Sepolia or live secrets. Sepolia smoke tests are opt-in, clearly named, and guarded by explicit configuration. Source the address from configuration, never duplicated across test files.

## Evidence

Report the exact commands run and whether they passed. If a relevant test cannot run, state why and what remains unverified.
