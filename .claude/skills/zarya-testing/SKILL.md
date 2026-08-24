---
name: zarya-testing
description: Design and implement tests for the Zarya Electron, PDF form, and Sepolia workflow — unit, integration, contract, local-chain, eligibility snapshots, Chairman authorization, persistence recovery, form round trips, hostile PDFs, queue, executor, IPC, and end-to-end. Prefer deterministic local tests; ordinary checks must never depend on Sepolia.
---

# Zarya testing strategy

> **No test runner is installed.** `package.json` has `typecheck` and `lint` only. Adding a runner is part of the first slice that needs tests — pick one that fits Vite and Electron rather than introducing a second toolchain.

Read `__ai/references/CONTRACT_DEFECTS.md` before testing governance semantics. Several of the contract's actual behaviors differ from what the product documentation implies, and a test written against the documentation would encode a requirement the contract does not meet.

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

## Pin the contract's real behavior, including the parts that look wrong

These are settled from source (`__ai/references/CONTRACT_DEFECTS.md`). Assert them as they are — a test that encodes the *intended* design instead will pass against a contract that does not exist.

- **Two rejection paths, two states.** Zero votes or quorum unmet reverts without finalizing → `UNEXECUTABLE`, and the voting must be suppressed from later discovery passes. Approval failure finalizes → `FINALIZED_REJECTED`. Neither is ever `RETRYABLE_ERROR`. The regression that matters: run reconciliation twice over a quorum-failed voting and assert the second pass does not attempt it.
- **A quorum set without a base does nothing.** Configure quorum `10`, leave the base unset, create a voting, and assert its snapshot is `simpleMajority`'s quorum of `1` — not `10`. Then set the base and assert a *new* voting picks up `10`. This is the trap most likely to be coded wrong.
- **Basis points, not percent.** Assert `simpleMajority()` reports `{1, 5000, 10000}` and that nothing renders `5000` as a percentage. A test that hardcodes `50` will pass today and break on any organ with a different base.
- **`castVote` takes two arguments.** Assert no call site passes an organ, and that vote intents and form schemas carry none. Then assert preflight rejects a non-member of the **voting's own** organ, accepts the Chairman anywhere, and accepts *any* address on a theme or statement voting — while the Chairman is *rejected* on a matrix-configuration voting where they are not a member. That asymmetry is easy to flatten by accident.
- **A voting whose organ is not yet projected** yields "eligibility undetermined", not "open to anyone". Assuming no organ would wrongly tell a non-member they may vote.
- **Region ordinals.** Assert against a region whose ordinal and subject code differ. A test using Chelyabinsk (74 both ways) passes under either reading and proves nothing.
- **The error registry** decodes `NoThemeSet`, `NoStatementSet`, `InvalidCategory`, and `Panic(0x11/0x12/0x32)` — none of which are in the ABI, so a fixture built from the ABI alone will not cover them. `Panic(0x12)` is no longer reachable from `executeVoting` but may still come from a contract that predates the fix.

Where something genuinely cannot be proven — anything requiring the deployed bytecode rather than the source — assert the invariant that holds either way and say so in the test name.

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
