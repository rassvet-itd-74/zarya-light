---
name: zarya-executor
description: Implement Zarya's automatic post-deadline voting executor and its manual Run now recovery action. Use for voting discovery, reconciliation loops, executeVoting jobs, executor health and status, periodic/startup/reconnect triggers, race handling, and worker recovery. Never use this skill to automate castVote, proposal creation, quorum or approval configuration, or chairmanship changes.
---

# Zarya executive reconciler

The executor performs only mechanical actions justified by current on-chain state. It never invents political intent and never changes governance policy.

Read `__ai/references/STATE_MACHINES.md` and `__ai/references/CONTRACT_DEFECTS.md`. Privilege rules are in `__ai/references/INVARIANTS.md`.

## Execution contract

```solidity
executeVoting(uint256 votingId) returns (bool)
```

One argument, confirmed by source and ABI. Quorum and approval are already snapshotted into the voting. Therefore the executor's input is a voting identity, never a threshold; it must not read today's organ configuration to judge an older voting; and it must never call the threshold setters.

Discovery derives ids from events, so `0` never arises there — but domain validation should still refuse it rather than spending a call. The contract now rejects it too.

## Some votings can never be executed — this is the core design constraint

Settled from `Votings.sol:416-445`. `executeVoting` finalizes on exactly one path, and the quorum path leaves the voting unfinalized **forever**:

| Outcome | State | Retry? |
| --- | --- | --- |
| quorum met, mutation applied | `FINALIZED_ACCEPTED` | done |
| quorum met, approval failed | `FINALIZED_REJECTED` | done — the contract finalized it |
| `InsufficientVotes` — zero votes, or quorum unmet | `UNEXECUTABLE` | **never** |
| `VotingAlreadyFinalized` | `ALREADY_FINALIZED` | done — lost the race |
| transport, RPC, submission | `RETRYABLE_ERROR` | yes |

An `UNEXECUTABLE` voting is past `endTime` and unfinalized, so `isVotingActive` and `isVotingFinalized` are both false and **discovery will offer it again on every single pass**. Persist the terminal classification and filter it out at candidate selection. This is the one place where local state must override what chain state keeps presenting — everywhere else, chain wins.

Getting this wrong produces an executor that burns gas retrying a guaranteed revert forever, and reports a settled political outcome as a technical failure.

The zero-vote case used to arrive as `Panic(0x12)` from a division by zero and now arrives as `InsufficientVotes`. Both classify the same way, so keep decoding `Panic(0x11)`, `Panic(0x12)`, and `Panic(0x32)` — the deployed contract may predate the guard, and an error registry built only from the ABI's 16 entries shows them as unknown selectors.

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

The table above is the full classification. Two rules on top of it:

- `BLOCKED` — signer, network, contract, or configuration prevents execution. Distinct from `UNEXECUTABLE`, which is about the voting; `BLOCKED` is about us.
- Never turn an unknown RPC state into a confirmed outcome. Absence of evidence is `PENDING`, to be reconciled.

Reconciling an applied mutation can use `ValueAdded` — it does exist and does fire, contrary to earlier notes here. It is absent from the ABI only because `Matricies.addValue` is an `external` library function, and the `DELEGATECALL` means the log still lands at the Zarya address. Register a hand-written fragment for it. Themes, statements, and decimals emit no application event, so those still need `VotingFinalized(success=true)` plus a domain read. See `CONTRACT.md`, "Symbols the ABI does not carry".

## Races

Two clients may target the same voting. The contract enforces one-time finalization. When this client loses, re-read state and classify as already finalized rather than retrying.

## Status

Expose a small derived DTO — health, plus waiting/ready/pending/failed counts, last check, current voting and transaction. Not internal rows. Health is not job state. `Run now` must be safe to press repeatedly.
