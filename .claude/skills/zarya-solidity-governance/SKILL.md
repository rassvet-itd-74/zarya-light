---
name: zarya-solidity-governance
description: Modify or review Zarya Solidity governance lifecycle — voting creation, castVote, eligibility snapshots, Chairman threshold configuration, executeVoting, finalization, events and getters, and the invariants the client depends on. Use only when Solidity behavior or the ABI must change; always pair with tests.
---

# Zarya Solidity governance

> **No Solidity source is present in this repository.** Only the compiled ABI (`src/chain/abi/Zarya.abi.json`) and the full artifact (`contracts/Zarya.json`). If a task requires changing contract behavior, the source must be obtained first — say so rather than working from the ABI alone. This skill is also the right lens for *reading* answers out of source once it is available.

Read `__ai/references/CONTRACT.md` for the current surface and `__ai/references/DOCUMENTATION_STATUS.md` for what the ABI could not settle.

## Questions source would answer immediately

These four are blocking client design. If source or a live contract becomes available, resolve them first — each takes minutes to read and unblocks real work.

1. **Does a failed voting revert or finalize?** `InsufficientVotes` is a custom error, yet `executeVoting` returns `bool` and `VotingFinalized` carries `success`. Read the `executeVoting` body. This decides the entire executor retry design.
2. **Does `castVote` have a Chairman branch?** The README says the Chairman may vote in any organ; other prose says members only. Read the authorization path.
3. **Is zero-vote execution guarded?** The approval formula divides by `totalVotes`.
4. **What is the `Region` enum's numbering?** Sequential from zero, or explicit subject codes?

## Current model

- `VotingEligibilityParameters { quorum, approvalPercentage, approvalPercentageBase }`
- `Voting.eligibilityParameters`, snapshotted at creation from `_votingEligibilityParametersByOrgan[organ]`
- organ-level configuration set by the Chairman; `simpleMajority` public for theme and statement votings
- `executeVoting(votingId)` — one argument, returning `bool`
- approval compared with a strict `>`

## Invariants — preserve, or change deliberately with tests

- Proposal types mutate state only through a successful governance path.
- `castVote` checks an active voting and one vote per address.
- Organ authorization and any Chairman override match intended policy.
- The threshold setters are Chairman-only.
- A voting snapshots eligibility at creation; a later organ change never rewrites an existing voting.
- Theme and statement votings receive `simpleMajority`.
- Finalization happens once; an accepted voting applies exactly one mutation.
- Rejected and zero-vote outcomes are terminal and explicit.
- The executor caller never chooses quorum or approval values.
- Chairman removal protection and `transferChairmanship` restriction stay coherent.
- Events and getters provide enough data for restartable off-chain reconciliation.

## Two gaps worth fixing if the contract is ever changed

- **No eligibility getter.** `_votingEligibilityParametersByOrgan` is `internal` and `getVotingResults` returns counts only, so the client cannot display the thresholds a voting will be judged against. Exposing a getter would remove a real product limitation — weigh it against gas and storage.
- **`ValueAdded` is documented but not emitted.** Off-chain indexing currently has to infer matrix changes from `VotingFinalized` plus `suggestionType`. Emitting the documented event would make indexing direct.

## When changing a signature

Update Foundry tests, update scripts, regenerate the ABI, refresh `src/chain/abi/Zarya.abi.json`, update the TypeScript adapters, update `__ai/references/CONTRACT.md`, and consider deployed-demo compatibility explicitly. `npm run ai:validate` will fail if the docs cite a symbol the new ABI lacks.

## Required tests

Eligibility snapshot regression — set threshold A, create voting 1, change to B, prove voting 1 still uses A and voting 2 uses B. Then: Chairman-only threshold configuration; Chairman cross-organ voting; exact approval boundary at, above, and below; zero total votes; exact deadline boundary; double execution; rejection finalization; membership and duplicate-vote denial; race idempotency; every proposal type's mutation; and the expected events and getters.

Fuzz the numeric parameters that feed the approval comparison.
