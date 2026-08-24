---
name: zarya-solidity-governance
description: Read or modify Zarya Solidity governance lifecycle — voting creation, castVote, eligibility snapshots, Chairman threshold configuration, executeVoting, finalization, events and getters, and the invariants the client depends on. Use when answering a question about what the contract actually does, or when contract behavior must change. Always pair a change with tests.
---

# Zarya Solidity governance

Source is present: `temporal_docs/Zarya.sol` plus `temporal_docs/libraries/{Votings,PartyOrgans,Matricies,Regions}.sol`. It matches the ABI's external surface exactly — `npm run ai:validate` re-checks that, so a source drop that no longer matches `src/chain/abi/Zarya.abi.json` fails the build.

This is the right lens for reading behavior out of source. Answers already extracted are in `__ai/references/CONTRACT.md`; behaviors that contradict the product design are in `__ai/references/CONTRACT_DEFECTS.md`. **Read the defects file before proposing any contract change** — most of what looks worth fixing is already recorded there with severity and consequence.

> `temporal_docs/` is supplied input. Do not edit it. A contract change means changing the real repository the contract lives in, and this one only holds a copy.

## Where behavior lives

- `Zarya.sol` — external surface, access-control modifiers, eligibility lookup, delegation into the libraries
- `Votings.sol` — the `Voting` struct, `castVote`, `executeVoting` and its checks, the mutation dispatch, every voting event
- `PartyOrgans.sol` — the `PartyOrgan` `bytes32` type, organ types, identifier construction
- `Matricies.sol` — cell storage as OZ checkpoints, values, categories, decimals, themes, statements
- `Regions.sol` — the 98-member `Region` enum and `toString`

The `internal`/`external` split in `Matricies` is load-bearing for the client, not an implementation detail: `external` library functions are deployed separately and their events and errors **do not appear in the calling contract's ABI**. That is why `ValueAdded` and three errors are invisible to an ABI-only client. If a change flips a function between `internal` and `external`, the client's event and error registry changes with it.

## Current model

- `VotingEligibilityParameters { quorum, approvalPercentage, approvalPercentageBase }`
- `Voting.eligibilityParameters` snapshotted at creation from `_votingEligibilityParametersByOrgan[organ]`; theme and statement votings snapshot the `simpleMajority` state variable instead
- `executeVoting(votingId)` — one argument, returning `bool`; finalizes on one path and reverts without finalizing on two
- approval compared with a strict `>`, after truncating integer division
- organs are `keccak256` of a Cyrillic identifier; `Chairperson`, `CentralSoviet`, and `Congress` ignore region and number
- the Chairman is a member of the Chairperson organ, which is how `_isChairman` works and how the client can check identity

## Remaining fixes worth making

A round of fixes landed on 2026-08-24 — the eligibility base setter and fallback, `castVote` organ scoping, the zero-vote guard, `votingId == 0`, and the move to basis points. `CONTRACT_DEFECTS.md` records them and what they left behind.

What is still worth changing, highest value first:

1. **Quorum failure reverts instead of finalizing.** `finalized` is never set, so the voting is permanently unexecutable and permanently rediscovered. Finalizing with `success = false` on a quorum miss — including the zero-vote case — would make the state machine uniform and let the client stop maintaining a local suppression list. This is now the top item.
2. **The approval base doubles as an enable flag.** `_getEligibilityParams` returns `simpleMajority` wholesale when the base is zero, so a quorum set without a base is silently discarded. Either default only the base rather than the whole struct, or add an explicit `configured` flag. As written, a Chairman can believe they have set a quorum and be wrong with no way to check.
3. **No getter for a voting's `governingOrgan`.** `castVote` depends on it and the client cannot read it, so vote eligibility has to be reconstructed from events. A one-line getter removes a whole class of client complexity.
4. **No eligibility getter.** `_votingEligibilityParametersByOrgan` is `internal` and `getVotingResults` returns counts only, so the client cannot display the thresholds a voting will be judged against, and cannot read back whether a configuration write took effect. With the base doubling as an enable flag, that second gap is sharp: a Chairman has no way to confirm an organ is configured. Weigh against gas.

Lower priority: theme and statement creation is permissionless while also being the only fully open vote — worth confirming that is intended; `duration` is unbounded; `CannotRemoveChairman` is checked at creation rather than execution; `get*ValueAtTimestamp` returns the queried timestamp rather than the checkpoint's.

When fixing 1, note it changes client behavior: the local suppression list becomes unnecessary, and `UNEXECUTABLE` collapses into `FINALIZED_REJECTED`. Say so in the change, so the client work is scheduled with it.

## Invariants — preserve, or change deliberately with tests

- Proposal types mutate state only through a successful governance path.
- `castVote` checks an active voting and one vote per address.
- The threshold setters are Chairman-only; the four matrix-configuration votings require actual organ membership even from the Chairman.
- A voting snapshots eligibility at creation; a later organ change never rewrites an existing voting.
- Theme and statement votings receive `simpleMajority`.
- Finalization happens once; an accepted voting applies exactly one mutation.
- Cell organ binding is first-writer-wins and permanent.
- The executor caller never chooses quorum or approval values.
- Chairman removal protection and `transferChairmanship` restriction stay coherent.
- Events and getters provide enough data for restartable off-chain reconciliation.

## When changing a signature

Update the tests, update scripts, regenerate the ABI, refresh `src/chain/abi/Zarya.abi.json`, update the TypeScript adapters, update `__ai/references/CONTRACT.md`, and consider deployed-demo compatibility explicitly. `npm run ai:validate` fails if the docs cite a symbol the new ABI lacks, and separately if the source's external surface stops matching the ABI.

## Required tests

There is no test suite in this repository. Any contract change needs one, and these are the cases the client depends on:

- **Eligibility snapshot regression** — set threshold A, create voting 1, change to B, prove voting 1 still uses A and voting 2 uses B.
- **The approval boundary with a non-zero base** — at, one above, one below. Impossible against the current contract, which is itself the finding.
- **Both rejection paths** — quorum miss must not finalize; approval failure must finalize with `success = false`. Assert `isVotingFinalized` after each.
- **Zero total votes** with quorum `0` and with quorum `1`; these take different paths.
- Chairman-only threshold configuration; Chairman cross-organ `castVote`; Chairman *denied* on a matrix-configuration voting.
- `castVote` with an organ unrelated to the voting's own.
- Exact deadline boundary — executable strictly after `endTime`, not at it.
- Double execution; race idempotency; membership and duplicate-vote denial.
- Every proposal type's mutation, and the events and getters each produces.
- **Region ordinal versus subject code** — assert that a region whose two numbers differ resolves to different organs, and pick one where they differ. A test written against Chelyabinsk passes under both readings and proves nothing.

Fuzz the numeric parameters that feed the approval comparison.
