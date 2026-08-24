---
name: zarya-persistence
description: Implement Zarya's durable local batch, job, issued-template, and audit storage plus crash recovery. Use for schema and migrations, operation state machines, operationRef records, transaction records, event cursors, startup reconciliation, resume and re-import, or repairing stale local state from chain. The database is never authoritative governance state.
---

# Zarya persistence and recovery

The database is durable operational memory. Chain state is authoritative for governance state and mined effects.

Read `__ai/references/STATE_MACHINES.md`. Recovery rules are in `__ai/references/INVARIANTS.md` under "Writes and recovery".

## Records

Model at minimum: issued template keyed by `operationRef`; returned form file hash and stored bytes; emitted receipt path and hash; batch; normalized operation identity; dependency edges; transaction attempt or job; chain, contract, and signer context; assigned nonce; last known receipt and block; classified error and status; executor voting job; and the voting-discovery block cursor.

## The issued-template record is a trust anchor

`operationRef` is how ingestion recovers authoritative context instead of reading it from an untrusted file. That makes this record load-bearing for correctness, not just for audit:

- Write it **before** the template file is handed to the user. An emitted form whose reference was never recorded is unbound in practice, and unbound forms lose the tamper check.
- Store the app-authored context alongside it — chainId, contract, organ triple, votingId, operationType — because that is what ingestion reads.
- Keep it after the operation completes, so a resubmitted copy of an old form resolves to a completed operation rather than to nothing.
- An `operationRef` that resolves to nothing is a rejection, never a reason to fall back to the file's own values.

Receipts are regenerated, not recovered: keep the returned form's bytes alongside the transaction record so a lost receipt can be re-stamped without a chain write. Store the receipt's own path and hash for audit, but treat the file as disposable output rather than state.

Use migrations. Never mutate schema implicitly at runtime without versioning.

## Uniqueness

Put constraints on true invariants. The important one:

```text
UNIQUE (chainId, contractAddress, votingId)   -- execution job
```

Do not rely on application `if` checks for race-sensitive uniqueness.

## Two projections, one cursor

The event cursor feeds both the executor's voting discovery and the matrix coordinate index. Persist the cursor once and let both projections read it — never maintain a second cursor or a second sweep.

The matrix index is derived state and safe to rebuild from the cursor at any time. The organ label reverse table is different: it maps `getPartyOrgan(triple) → bytes32` through `pure` helpers, so it can never go stale and should be cached permanently rather than rebuilt per report.

## The discovery cursor

`VotingCreated` is the only source of a voting's `endTime` — no getter exposes it. The persisted block cursor is therefore load-bearing, not an optimization: losing it means losing every deadline the executor depends on.

Make it restartable, and reconcile indexed votings against `isVotingFinalized` rather than trusting local terminal state.

## Reconciliation

On startup and every relevant trigger:

1. load non-terminal local jobs
2. verify provider and network identity
3. resolve known transaction hashes and receipts
4. read domain state for ambiguous or apparently completed operations
5. repair local state
6. enqueue only work still required

Never `if (db.done) return` without chain evidence where a false local state could cause a duplicate irreversible write.

Examples: if chain says the signer has voted, a local `CastVote` becomes `ALREADY_COMPLETED` even after a crash. If a voting is finalized, mark the executor job terminal regardless of a stale local `READY` or `PENDING` — reading the outcome from `VotingFinalized(success)` rather than assuming it.

**One exception to chain-wins, and it needs its own column.** A voting that failed quorum reverts without finalizing, so it is unexecutable forever while still looking like a live candidate: past `endTime`, not active, not finalized. Chain state will offer it on every reconciliation pass. Persist the terminal classification and filter it at candidate selection, or the executor retries a guaranteed revert indefinitely. This is the only place where local state legitimately overrides what chain state presents — see "Quorum failure is permanent" in `__ai/references/CONTRACT_DEFECTS.md`, and the `UNEXECUTABLE` state in `STATE_MACHINES.md`.

## Transactions and audit

Wrap multi-row local transitions in DB transactions. Never hold one open across an RPC call.

Retain enough immutable metadata to trace `issued template → returned form → normalized intent → transaction attempt → hash and receipt → domain result`. Record any tamper divergence as part of that trail. Keep secrets out of audit and log tables.
