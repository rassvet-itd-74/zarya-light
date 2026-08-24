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
WAITING             # voting exists but deadline not reached
READY               # overdue + unfinalized
SIGNING
BROADCAST
PENDING
FINALIZED_ACCEPTED
FINALIZED_REJECTED  # quorum met, approval failed — the contract finalized it
UNEXECUTABLE        # terminal: the contract will never finalize this voting
RETRYABLE_ERROR
BLOCKED
```

Two rejections, two states, neither of them `RETRYABLE_ERROR`:

- **Zero votes, or quorum not met** — `executeVoting` reverts `InsufficientVotes` and never sets `finalized`. `UNEXECUTABLE`, terminal, never retried.
- **Quorum met, approval failed** — the contract finalizes with `success = false` and emits `VotingFinalized`. `FINALIZED_REJECTED`, the ordinary terminal rejection.

`UNEXECUTABLE` is not an error state and not a retry state. Such a voting stays unfinalized on chain forever, so **discovery will keep offering it as a candidate on every pass**. This is the one place where local state must suppress what chain state keeps presenting — record it and stop attempting it. Reserve `RETRYABLE_ERROR` for transport and submission transients. See "Quorum failure is permanent" in `CONTRACT_DEFECTS.md`.

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
