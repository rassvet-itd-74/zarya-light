---
name: zarya-batch-engine
description: Implement Zarya bulk form batching, validation summaries, deduplication, dependencies, partial submission, resume and cancel, and batch progress UI models. Use whenever multiple returned PDF forms are imported at once or a workflow spans multiple transactions. Not for private-key handling.
---

# Zarya batch engine

Read the "Form intake" and "Bulk execution" sections of `__ai/references/USE_CASES.md` for acceptance criteria, and `__ai/references/STATE_MACHINES.md` for batch and item states. Form parsing is `zarya-pdf-forms`.

## A batch is a persisted object

Not a loop around the single-file submit action. It preserves: a stable batch ID; source form records and hashes; `operationRef` where present; normalized intent or validation error; semantic operation identity; dependency edges; preflight result; job state; and transaction hash, receipt metadata, and error classification.

## Lifecycle

1. Discover and import all files.
2. Hash and parse all files.
3. Validate all intents.
4. Detect duplicates and conflicts.
5. Resolve currently resolvable dependencies.
6. Preflight chain-dependent ready operations.
7. Present the review summary.
8. **Only on explicit submission**, enqueue ready writes.
9. Persist every transition.
10. Reconcile on restart or re-import.

No chain write happens during file drop or import.

## Partial progress

An invalid independent item does not block valid independent items. A failed dependency blocks its dependents only. Confirmed transactions are immutable history — cancel affects unsent work alone. `PARTIAL` is a normal outcome, not a broken one.

## Dependencies

Model as a DAG. Detect cycles before submission. Never assume a dependency is satisfied because its parent transaction was *sent* — a governance dependency may wait days for on-chain finalization. Persist `WAITING_FOR_ONCHAIN_CONDITION` across restarts.

## Dedup and conflicts

Three signals, in increasing authority: the binary file hash for same-file detection; `operationRef` for "this is the form we issued for that operation"; and semantic identity plus chain state for logical duplicates. `hasVoted` remains the final protection for votes.

Two returned copies of the same `operationRef` are the same operation, however much their contents differ — treat the second as a duplicate, not a second intent.

If two forms conflict semantically — same signer and voting, opposite direction — mark a conflict requiring user action. Never resolve it by import order.

A batch item whose app-authored fields diverge from its record carries a tamper disclosure through to review. It is submittable, since the divergent values were never read, but the user sees the divergence first.

## Queue policy

One logical intent, one transaction. Serialize writes per signer wallet. No `Promise.all(sendTransaction)`. Do not introduce write multicall for throughput.

## UI DTOs

Expose derived summaries, not database internals: valid and invalid before submission; ready, blocked, and already-completed; queued, processing, confirmed, and failed during submission.
