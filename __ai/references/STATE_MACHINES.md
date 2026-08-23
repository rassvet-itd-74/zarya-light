# State machines

Use explicit finite states. Avoid encoding workflow state as scattered booleans.

## Issued template state

```text
REQUESTED -> CONTEXT_READ -> RECORDED -> EMITTED -> RETURNED
                 |                                     |
                 v                                     v
             UNAVAILABLE                         SUPERSEDED
```

`RECORDED` precedes `EMITTED`: the operation and its `operationRef` are persisted before the file reaches the user. A template may also never come back, so `EMITTED` is not a failure state and must not be retried automatically.

## Form parse state

```text
DISCOVERED -> READING -> PARSED -> BOUND -> VALID
                         |          |        |
                         v          v        v
                      REJECTED   UNBOUND  INVALID
                                             |
                                             v
                                         PREFLIGHT
```

`REJECTED` covers structural refusal — unknown `schemaVersion`, XFA present, encrypted, flattened, a populated `zarya.receipt.txHash`, unknown field name — and is distinct from `INVALID`, which means the schema parsed but a value failed validation. `BOUND` means `operationRef` resolved to a known operation and authoritative context was recovered from storage.

## Receipt state

```text
AWAITING_CONFIRMATION -> STAMPED -> WRITTEN
          |
          v
      NOT_STAMPED
```

`AWAITING_CONFIRMATION` starts at broadcast, not at signing, and no receipt exists during it. `STAMPED` requires a confirmed transaction with a known status; `NOT_STAMPED` covers a transaction that never reached a terminal outcome the client can prove.

A reverted transaction still produces a receipt — `zarya.receipt.status = REVERTED`. Absence of a receipt means "outcome unknown", never "it failed".

Stamping is idempotent and re-runnable: the receipt is a rendering of the stored form plus transaction record, so `WRITTEN` can be reached again after a lost file without touching the chain.

## Preflight/operation state

Suggested logical states:

```text
NOT_STARTED
READY
BLOCKED
ALREADY_COMPLETED
WAITING_FOR_DEPENDENCY
QUEUED
SIGNING
SIGNED
BROADCAST
PENDING
CONFIRMED
FAILED_RETRYABLE
FAILED_TERMINAL
SKIPPED
```

The implementation may collapse states if tests still preserve required distinctions.

## Batch state

```text
PARSING
READY
SUBMITTING
PARTIAL
COMPLETED
CANCELLED
CANCELLED_PARTIAL
```

A batch status is derived from item states where practical.

## Executive job state

```text
WAITING       # voting exists but deadline not reached
READY         # overdue + unfinalized
SIGNING
BROADCAST
PENDING
FINALIZED_ACCEPTED
FINALIZED_REJECTED
RETRYABLE_ERROR
BLOCKED
```

## Executor health

```text
HEALTHY
WORKING
DEGRADED
STOPPED
```

Health is not the same as job state.

## Important transition rules

- `PENDING -> FAILED` requires evidence; RPC loss alone yields unknown/pending-reconcile, not permanent failure.
- `READY -> ALREADY_COMPLETED` is valid after a chain re-check.
- A form-driven `castVote` can become `ALREADY_COMPLETED` if the member already voted, even if this local file was never processed.
- A returned form whose app-authored fields diverge from its record is `VALID` only after the divergence is disclosed. Tampering is a disclosure event, not a parse failure, because the file's copies are never read for value.
- Restart may move stale local states forward or backward only after reconciliation evidence.

### `FINALIZED_REJECTED` is unverified

The intended rule is that a politically rejected voting ends in `FINALIZED_REJECTED` rather than `RETRYABLE_ERROR`. **It is not known whether the contract behaves that way.** `InsufficientVotes` is a custom error, which suggests a failed voting reverts and is never finalized at all — in which case this state is unreachable and a retry policy would loop forever on a settled political outcome.

See `DOCUMENTATION_STATUS.md` open item 1. Until it is closed, classify `InsufficientVotes` as terminal-pending-verification and keep it distinct from transport failure. Do not build a retry path that assumes the revert is transient.
