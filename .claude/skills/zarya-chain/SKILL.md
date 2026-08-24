---
name: zarya-chain
description: Implement Zarya Sepolia contract adapters, ABI-backed reads, organ resolution, Chairman-aware preflight, voting discovery, event decoding, and custom-error classification. Use for any code that reads Zarya on-chain state or turns typed intents into contract calls. Pair with zarya-transactions for signing and writes.
---

# Zarya chain adapter

Read `__ai/references/CONTRACT.md` first — the full surface from the Solidity source, including what is **not** exposed. Read `__ai/references/CONTRACT_DEFECTS.md` before writing organ resolution, preflight, or error classification; most of it lands directly on this adapter. Network and address: `__ai/references/DEPLOYMENT.md`.

The ABI is at `src/adapters/chain/abi/Zarya.abi.json`. Do not hand-write signatures — generate types from the ABI or import it directly. But the ABI is not the whole surface: four errors and one event are declared in externally-linked libraries and are absent from it. Register those by hand.

## What exists (Phase 2, slice 1)

The library is **viem**. `publicClient.ts` builds the read-only client — there is no wallet client anywhere in this phase. `zaryaAbi.ts` imports the ABI as the single source and asserts at load that every function this code calls exists with the expected arity, which is how a drifted ABI fails loudly instead of at the first call. `chainClock.ts` implements `Clock`. `networkGuard.ts` observes; `domain/network/networkIdentity.ts` decides.

Two patterns to follow when extending it:

- **Importing the ABI as JSON widens it to `Abi`, and viem's `readContract` generics do not survive that.** Use `encodeFunctionData` → `client.call` → `decodeFunctionResult` instead. Same wire behavior, no generic fight.
- **A revert and a transport failure arrive at the same catch site and mean opposite things.** `revertData.ts` separates them, and returns "not a revert" when unsure. Never let an RPC timeout become a verdict about the contract.

Testing is against a local **anvil forking Sepolia** — the real deployment, nothing compiled locally, nothing broadcast. See `testing/anvil.ts`; opt-in via `ZARYA_FORK_RPC_URL`.

## Organ resolution comes first

An organ is a `bytes32` produced by a `pure` helper:

```solidity
getPartyOrgan(uint8 organType, uint8 region, uint256 number) pure returns (bytes32)
```

Carry the **structured triple** through the domain model. Never hash a Cyrillic identifier string yourself, and never store an organ as a display label.

> **`region` is the `Region` enum ordinal, never the subject code.** They differ for 50 of 98 regions, and passing a code addresses a *different real region* rather than reverting. Validate every resolution against `getPartyOrganIdentifier`, which is `pure` and therefore free: the label contains the subject code, so comparing it against the code you expected detects a wrong ordinal. Do this on each resolution, not once at startup. See "A region has two representations" in `CONTRACT_DEFECTS.md`.

Three organ types — `Chairperson`, `CentralSoviet`, `Congress` — **ignore `region` and `number` entirely**. They are single global organs, so do not model them as region-scoped or cache them per region.

Resolution runs both ways, and only one direction has a getter. Triple → `bytes32` is `getPartyOrgan`. For `bytes32` → label there is **no getter**, so build a reverse index by enumerating plausible triples through the `pure` helpers and keying by `bytes32`. The mapping cannot change, so cache it indefinitely. An unresolved `bytes32` is displayed verbatim, never guessed.

## Adapter boundary

Keep the chain library behind a domain interface. Parser, batch, and UI code must not call contract methods directly.

Responsibilities: network and contract identity checks, organ resolution, voting reads, membership and `hasVoted` reads, matrix metadata for preflight, static simulation, intent-to-call mapping, receipt and event decoding, custom error decoding, executor discovery.

## Network guard

Verify chainId before writes and after every reconnect. Verify the configured address has code. See `DEPLOYMENT.md` — do not embed the address in domain code.

## Preflight

Preflight is UX, not authorization. Always handle state changing between preflight and mining. Mirror the contract's checks exactly — anything stricter rejects calls the contract would accept. The authoritative table is in `CONTRACT.md` under "Access control".

- `CastVote` — active? already voted? Member of **the voting's own organ**, which the contract reads from stored state; the call takes no organ argument. The Chairman is exempt. Theme and statement votings have no organ, so anyone may vote — do not reject those for non-membership. The organ itself has **no getter**: recover it from the creation event, and if the projection has no entry for that voting, treat eligibility as undetermined and simulate rather than assuming the voting is open. See "A voting's governing organ has no getter" in `CONTRACT_DEFECTS.md`.
- `SetMinimumQuorum` / `SetMinimumApprovalPercentage` / `TransferChairmanship` — Chairman identity **is** readable despite there being no `getChairman()`: `isMember(getPartyOrgan(Chairperson, 0, 0), signer)`. Check it for UX, and still simulate.
- `CreateTheme` / `CreateStatement` — permissionless. No membership check at all; do not add one.
- The four matrix-configuration votings — strict organ membership, and the **Chairman is not exempt**. This is the one place the Chairman override does not apply.
- Value proposals — allowed category, cell organ, and decimals metadata via the `get*CellInfo` reads.
- `duration` — bound it. The contract accepts anything, including `0`.

`votingId == 0` is now rejected by the contract, so preflight need not special-case it — but domain validation should still refuse it rather than spending a call.

## Voting discovery

`VotingCreated(votingId indexed, author indexed, startTime, endTime, suggestionType)` is the primitive, and the **only** source of `endTime` — there is no voting-struct getter.

Index it with a persisted block cursor and reconcile against `isVotingFinalized`. `nextVotingId()` supports bounded paging as a fallback. Never rescan the chain on every poll.

The same cursor feeds a second projection: the **matrix coordinate index**. Build it as another consumer of this cursor, never as an independent sweep. See `zarya-matrix-report`.

Use the chain block timestamp for deadline decisions, never workstation wall clock.

## Eligibility

Each voting snapshots its eligibility at creation. The adapter must never compute execution eligibility from client constants or from today's organ configuration, and `executeVoting(votingId)` takes no policy arguments.

`simpleMajority()` is readable and reports **basis points** — `{1, 5000, 10000}`. Never render an approval figure without dividing by its own base, and never normalize to percent.

Per-organ and per-voting eligibility are **not** readable — no getter exists. So a configuration write cannot be read back, and UI cannot display effective thresholds. Do not fabricate a read API for either.

Resolution falls back to `simpleMajority` whenever an organ's `approvalPercentageBase` is zero, which means the base acts as an enable flag: a quorum written without a base is silently ignored. If the adapter exposes threshold configuration, write all three together. See "The approval base doubles as an enable flag" in `CONTRACT_DEFECTS.md`.

## Errors

Decode the ABI's 16 custom errors and map them to domain meaning — the taxonomy is in `CONTRACT.md`. Then extend it, because the ABI is incomplete: `NoThemeSet`, `NoStatementSet`, and `InvalidCategory` are raised from `external` library functions and arrive as undecodable selectors, and `Panic(0x11)`, `Panic(0x12)`, `Panic(0x32)` are reachable and undescribed. Register all seven by hand.

Three that need care:

- `AlreadyVoted` and `VotingAlreadyFinalized` are **idempotent completion**, not failure.
- `InsufficientVotes` is **terminal** — zero votes or quorum unmet. The voting never finalizes and never becomes executable. Never retryable.
- `InvalidOrgan` means the cell is bound to a different organ — binding is first-writer-wins and permanent. It is also what a wrong region ordinal produces against an already-bound cell, so check the ordinal before blaming the cell.

Never turn an unknown RPC state into a confirmed failure.

## `ValueAdded` exists

It is declared at `Matricies.sol:45`, does fire at the Zarya address, and is missing from the ABI only because `addValue` is an `external` library function. Subscribe with a hand-written fragment; `x` and `y` are indexed. It does **not** carry `isCategorical`, so disambiguate by reading `getCategoricalCellOrgan` / `getNumericalCellOrgan`. `setTheme`, `setStatement`, and `setDecimals` emit nothing, so those changes are observable only through creation events plus finalization.
