---
name: zarya-executor
description: Implement Zarya's automatic post-deadline voting executor and its manual Run now recovery action. Use for voting discovery, reconciliation loops, executeVoting jobs, executor health and status, periodic/startup/reconnect triggers, race handling, and worker recovery. Never use this skill to automate castVote, proposal creation, quorum or approval configuration, or chairmanship changes.
---

# Zarya executive reconciler

The executor performs only mechanical actions justified by current on-chain state. It never invents political intent and never changes governance policy.

Read `__ai/references/STATE_MACHINES.md` and `__ai/references/DOCUMENTATION_STATUS.md`. Privilege rules are in `__ai/references/INVARIANTS.md`.

## Execution contract

```solidity
executeVoting(uint256 votingId) returns (bool)
```

One argument, confirmed by the ABI. Quorum and approval are already snapshotted into the voting. Therefore the executor's input is a voting identity, never a threshold; it must not read today's organ configuration to judge an older voting; and it must never call the threshold setters.

## Resolve rejection semantics before designing retries

**This is the one thing that must not be assumed.** `InsufficientVotes(uint256,uint256)` is a custom error, which suggests a failed voting *reverts* and is never finalized. But `executeVoting` returns `bool` and `VotingFinalized` carries a `success` flag, which suggests it finalizes as rejected.

If it reverts and you treat the revert as retryable, the executor retries a settled political outcome forever and reports it as a technical failure.

Until `DOCUMENTATION_STATUS.md` #1 is closed: classify `InsufficientVotes` as terminal-pending-verification, keep it distinct from transport failure, and do not implement a retry path that assumes the revert is transient.

Note also that the approval formula divides by `totalVotes`, so an expired voting with zero votes may panic. An executor that discovers overdue votings will eventually hit that case — see #3.

## One reconciliation implementation

Periodic execution, application startup, RPC reconnect, worker restart, and the UI `Run now` action all call the same core `reconcile()`. There is no separate manual-execution algorithm.

1. Verify network and contract identity.
2. Resolve ambiguous local pending execution transactions.
3. Discover candidate voting IDs via the `VotingCreated` cursor — the only source of `endTime`.
4. Read current state for each candidate.
5. Finalized → repair the local job to terminal state.
6. `endTime` not reached by chain time → `WAITING`.
7. Overdue and unfinalized → ensure one unique execution job, mark `READY`.
8. Process ready jobs through the shared serialized transaction engine.
9. Re-read state and events after receipt or revert, then classify.
10. Publish derived health and counts.

## No timer correctness

A periodic interval may wake the reconciler, but correctness must survive missed ticks, sleep, process kill, app exit, and clock changes. Never make `setTimeout(deadline - now)` the only execution mechanism.

## Outcomes

Distinguish only what the contract lets you prove:

- finalized and applied — confirmed by `VotingFinalized(success=true)` plus a domain read
- `ALREADY_FINALIZED` — `VotingAlreadyFinalized`; another client won the race
- `RETRYABLE_ERROR` — transport, RPC, or submission transients only
- `BLOCKED` — signer, network, contract, or configuration prevents execution
- terminal-pending-verification — `InsufficientVotes`, per above

Do not infer "politically rejected" from a revert until the contract semantics are established.

Reconciling an applied mutation requires a domain read: the `ValueAdded` event the whitepaper describes does not exist in the ABI.

## Races

Two clients may target the same voting. The contract enforces one-time finalization. When this client loses, re-read state and classify as already finalized rather than retrying.

## Status

Expose a small derived DTO — health, plus waiting/ready/pending/failed counts, last check, current voting and transaction. Not internal rows. Health is not job state. `Run now` must be safe to press repeatedly.
