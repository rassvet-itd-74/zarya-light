---
name: zarya-transactions
description: Implement safe serialized Ethereum transaction submission for Zarya — signer abstraction, nonce discipline, signing/broadcast/receipt lifecycle, retry classification, pending and stuck handling, and optional signed-transaction outbox. Use for form-driven writes and executor writes. Governance policy is decided elsewhere.
---

# Zarya transaction engine

Read `__ai/references/STATE_MACHINES.md` for the operation states. Write and secret rules are in `__ai/references/INVARIANTS.md` under "Writes and recovery" and "Secrets".

This layer moves signed bytes. It decides nothing about governance.

## Lifecycle

```text
READY -> SIGNING -> [SIGNED] -> BROADCAST -> PENDING -> CONFIRMED
```

`SIGNED` exists only if you implement a raw outbox.

Persist each transition before exposing it as durable status.

## Nonce discipline

Serialize writes per EOA. One active write per signer is the default and is sufficient — the member wallet and executor wallet are separate, so they do not contend.

Read and synchronize the pending nonce appropriately, and persist the nonce with the job once assigned if recovery needs it. Do not parallelize same-wallet writes for throughput without an explicit requirement and tests covering nonce gaps and replacement.

## Crash windows

Design and test all five:

1. crash before signing
2. crash after signing, if an outbox exists
3. crash after broadcast, before the hash is persisted
4. crash after the hash is persisted, before receipt
5. crash after mining, before the domain state update

If the implementation cannot guarantee recovery for one of these, **document the limitation** rather than implying exactly-once submission.

## Pending and stuck

`PENDING` is never `FAILED`. An RPC outage means reconcile later. `STUCK` may initially be a surfaced state with receipt re-checking. Replacement-by-fee is a separate deliberate feature: same nonce, explicit fee bump, its own tests.

## Receipts

On receipt: decode status and revert reason, decode the expected domain event, then perform a domain-state read before final classification whenever correctness depends on chain state.

This is also the hook point for stamping the form receipt — **on confirmation, never on broadcast.** A form stamped "sent" for a transaction that later reverts or is dropped becomes a false record someone may have already printed. Pass the confirmed transaction record to `zarya-pdf-forms`; do not let the queue emit a final receipt from a pending state.

Decode against the full custom-error taxonomy in `__ai/references/CONTRACT.md`. Two cases must not be misfiled:

- `AlreadyVoted` and `VotingAlreadyFinalized` are idempotent completion.
- `InsufficientVotes` is not retryable — see `__ai/references/DOCUMENTATION_STATUS.md` #1.

## Outbox (optional hardening)

Populate → assign nonce → sign → derive hash → persist signed payload with hash and nonce → broadcast → rebroadcast the identical payload after an ambiguous failure.

Store raw signed transactions only if the security model explicitly accepts it.
