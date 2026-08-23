---
name: zarya-chain
description: Implement Zarya Sepolia contract adapters, ABI-backed reads, organ resolution, Chairman-aware preflight, voting discovery, event decoding, and custom-error classification. Use for any code that reads Zarya on-chain state or turns typed intents into contract calls. Pair with zarya-transactions for signing and writes.
---

# Zarya chain adapter

Read `__ai/references/CONTRACT.md` first — it records the full surface from the ABI, including what is **not** exposed. Read `__ai/references/DOCUMENTATION_STATUS.md` before relying on rejection semantics, Chairman authorization, zero-vote behavior, or organ encoding. Network and address: `__ai/references/DEPLOYMENT.md`.

The ABI is at `src/chain/abi/Zarya.abi.json`. Do not hand-write signatures — generate types from it or import it directly.

## Organ resolution comes first

An organ is a `bytes32` produced by a `pure` helper:

```solidity
getPartyOrgan(uint8 organType, uint8 region, uint256 number) pure returns (bytes32)
```

Carry the **structured triple** through the domain model. Never hash a Cyrillic identifier string yourself, and never store an organ as a display label.

> **Resolve the region encoding before writing any organ-addressed call.** The whitepaper annotates `Region` enum entries with subject codes (`// = 74`) but Solidity enums are sequential from zero. `getPartyOrganIdentifier` is `pure`, so probing candidates against the expected label is a free read. Getting this wrong yields a valid-looking wrong `bytes32` — every downstream call then fails with `InvalidOrgan` or silently addresses another organ. See `DOCUMENTATION_STATUS.md` #4.

## Adapter boundary

Keep the chain library behind a domain interface. Parser, batch, and UI code must not call contract methods directly.

Responsibilities: network and contract identity checks, organ resolution, voting reads, membership and `hasVoted` reads, matrix metadata for preflight, static simulation, intent-to-call mapping, receipt and event decoding, custom error decoding, executor discovery.

## Network guard

Verify chainId before writes and after every reconnect. Verify the configured address has code. See `DEPLOYMENT.md` — do not embed the address in domain code.

## Preflight

Preflight is UX, not authorization. Always handle state changing between preflight and mining.

- `CastVote` — active? already voted? For an ordinary member, organ membership. **Do not reject a Chairman cross-organ vote**; that authorization rule is unverified, so simulate and let the contract decide.
- `SetMinimumQuorum` / `SetMinimumApprovalPercentage` / `TransferChairmanship` — **there is no `getChairman()` getter.** Chairman identity comes from configuration. Simulate the call and catch `NotChairman` rather than pre-checking identity.
- Value proposals — allowed category, cell organ, and decimals metadata via the `get*CellInfo` reads.

## Voting discovery

`VotingCreated(votingId indexed, author indexed, startTime, endTime, suggestionType)` is the primitive. It is the **only** source of `endTime` — there is no voting-struct getter.

Index it with a persisted block cursor and reconcile against `isVotingFinalized`. `nextVotingId()` supports bounded paging as a fallback. Never rescan the chain on every poll.

Use the chain block timestamp for deadline decisions, never workstation wall clock.

## Eligibility

Each voting snapshots its eligibility at creation. The adapter must never compute execution eligibility from client constants or from today's organ configuration, and `executeVoting(votingId)` takes no policy arguments.

`simpleMajority()` is readable. Per-organ and per-voting eligibility are **not** — no getter exists. Do not fabricate a read API for them, and do not design UI that displays them.

## Errors

Decode all 16 custom errors and map them to domain meaning. The taxonomy is in `CONTRACT.md` — use it rather than inventing generic categories.

Two that need care:
- `AlreadyVoted` and `VotingAlreadyFinalized` are **idempotent completion**, not failure.
- `InsufficientVotes` may mean the voting never finalizes at all. Do not classify it as retryable. See `DOCUMENTATION_STATUS.md` #1.

Never turn an unknown RPC state into a confirmed failure.

## Absent event

The whitepaper promises a `ValueAdded` event. **It does not exist.** Derive matrix changes from `VotingFinalized(success=true)` plus `suggestionType`, or poll `getCategoricalLatestValue` / `getNumericalLatestValue`. Do not write a listener for it.
