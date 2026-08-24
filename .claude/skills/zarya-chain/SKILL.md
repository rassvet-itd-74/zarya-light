---
name: zarya-chain
description: Implement Zarya Sepolia contract adapters, ABI-backed reads, organ resolution, Chairman-aware preflight, voting discovery, event decoding, and custom-error classification. Use for any code that reads Zarya on-chain state or turns typed intents into contract calls. Pair with zarya-transactions for signing and writes.
---

# Zarya chain adapter

Read `__ai/references/CONTRACT.md` first — it records the full surface from the Solidity source, including what is **not** exposed. Read `__ai/references/CONTRACT_DEFECTS.md` before writing organ resolution, preflight, or error classification; most of it lands directly on this adapter. Network and address: `__ai/references/DEPLOYMENT.md`.

The ABI is at `src/chain/abi/Zarya.abi.json`; the source it was compiled from is `temporal_docs/Zarya.sol`. Do not hand-write signatures — generate types from the ABI or import it directly. But the ABI is not the whole surface: four errors and one event are declared in externally-linked libraries and are absent from it. Register those by hand.

## Organ resolution comes first

An organ is a `bytes32` produced by a `pure` helper:

```solidity
getPartyOrgan(uint8 organType, uint8 region, uint256 number) pure returns (bytes32)
```

Carry the **structured triple** through the domain model. Never hash a Cyrillic identifier string yourself, and never store an organ as a display label.

> **`region` is the `Region` enum ordinal, never the subject code.** They differ for 50 of 98 regions, and passing a code addresses a *different real region* rather than reverting — only two of 98 are out of enum bounds. Worse, Chelyabinsk is ordinal 74 *and* code "74", so the project's own region works either way and hides the bug in every test written against it.
>
> Validate every resolution against `getPartyOrganIdentifier`, which is `pure` and therefore free: the label it returns contains the subject code, so comparing that against the code you expected detects a wrong ordinal. Do this on each resolution, not once at startup. See "Region ordinals are not subject codes" in `CONTRACT_DEFECTS.md`.

Three organ types — `Chairperson`, `CentralSoviet`, `Congress` — **ignore `region` and `number` entirely**. They are single global organs, so do not model them as region-scoped or cache them per region.

Resolution runs both ways, and only one direction has a getter. Triple → `bytes32` is `getPartyOrgan`. For `bytes32` → label there is **no getter**, so build a reverse index by enumerating plausible triples through the `pure` helpers and keying by `bytes32`. Both helpers are `pure` and the mapping cannot change, so cache it indefinitely. An unresolved `bytes32` is displayed verbatim, never guessed.

## Adapter boundary

Keep the chain library behind a domain interface. Parser, batch, and UI code must not call contract methods directly.

Responsibilities: network and contract identity checks, organ resolution, voting reads, membership and `hasVoted` reads, matrix metadata for preflight, static simulation, intent-to-call mapping, receipt and event decoding, custom error decoding, executor discovery.

## Network guard

Verify chainId before writes and after every reconnect. Verify the configured address has code. See `DEPLOYMENT.md` — do not embed the address in domain code.

## Preflight

Preflight is UX, not authorization. Always handle state changing between preflight and mining. Mirror the contract's checks exactly — anything stricter rejects calls the contract would accept. The authoritative table is in `CONTRACT.md` under "Access control".

- `CastVote` — active? already voted? Member of **the voting's own organ**, which the contract reads from stored state; the call takes no organ argument. The Chairman is exempt. Theme and statement votings have no organ, so anyone may vote — do not reject those for non-membership. The organ itself has **no getter**: recover it from the creation event, and if the projection has no entry for that voting, treat eligibility as undetermined and simulate rather than assuming the voting is open. See "A voting's governing organ has no getter" in `CONTRACT_DEFECTS.md`.
- `SetMinimumQuorum` / `SetMinimumApprovalPercentage` / `TransferChairmanship` — Chairman identity **is** readable, despite there being no `getChairman()`: the Chairman is a member of the Chairperson organ, so `isMember(getPartyOrgan(Chairperson, 0, 0), signer)` answers it. Check it for UX, and still simulate, since the answer can change before mining.
- `CreateTheme` / `CreateStatement` — permissionless. No membership check at all; do not add one.
- The four matrix-configuration votings — strict organ membership, and the **Chairman is not exempt**. This is the one place the Chairman override does not apply.
- Value proposals — allowed category, cell organ, and decimals metadata via the `get*CellInfo` reads.
- `duration` — bound it. The contract accepts anything, including `0`.

`votingId == 0` is now rejected by the contract, so preflight need not special-case it — but domain validation should still refuse it rather than spending a call to learn what it already knows.

## Voting discovery

`VotingCreated(votingId indexed, author indexed, startTime, endTime, suggestionType)` is the primitive. It is the **only** source of `endTime` — there is no voting-struct getter.

Index it with a persisted block cursor and reconcile against `isVotingFinalized`. `nextVotingId()` supports bounded paging as a fallback. Never rescan the chain on every poll.

The same cursor feeds a second projection: the **matrix coordinate index**. There is no dimension getter and no cell enumeration, so cells are discovered from events — `ValueAdded` and `CategoryAdded` directly, everything else from creation events gated on `VotingFinalized(success = true)`. Build it as another consumer of this cursor, never as an independent sweep. See `zarya-matrix-report`.

Use the chain block timestamp for deadline decisions, never workstation wall clock.

## Eligibility

Each voting snapshots its eligibility at creation. The adapter must never compute execution eligibility from client constants or from today's organ configuration, and `executeVoting(votingId)` takes no policy arguments.

`simpleMajority()` is readable and reports **basis points** — `{1, 5000, 10000}`. Never render an approval figure without dividing by its own base, and never normalize to percent.

Per-organ and per-voting eligibility are **not** readable — no getter exists. So a configuration write cannot be read back, and UI cannot display effective thresholds. Do not fabricate a read API for either.

Resolution falls back to `simpleMajority` whenever an organ's `approvalPercentageBase` is zero, which means the base acts as an enable flag: a quorum written without a base is silently ignored. If the adapter exposes threshold configuration, write all three together. See "The approval base doubles as an enable flag" in `CONTRACT_DEFECTS.md`.

## Errors

Decode the ABI's 16 custom errors and map them to domain meaning. The taxonomy is in `CONTRACT.md`. Then extend it, because the ABI is incomplete:

- **`NoThemeSet`, `NoStatementSet`, `InvalidCategory`** are declared in `Matricies` and raised from `external` library functions, so they are absent from the ABI and arrive as undecodable selectors. Register them by hand.
- **`Panic(0x11)`, `Panic(0x12)`, `Panic(0x32)`** are reachable — overflow, the zero-vote division, and an out-of-bounds `get*ValueAt`. The ABI describes none of them.

Three that need care:
- `AlreadyVoted` and `VotingAlreadyFinalized` are **idempotent completion**, not failure.
- `InsufficientVotes` is **terminal** — zero votes or quorum unmet. The voting never finalizes and never becomes executable. Never retryable. See "Quorum failure is permanent".
- `InvalidOrgan` means the cell is bound to a different organ — binding is first-writer-wins and permanent. It is also what a wrong region ordinal produces against an already-bound cell, so check the ordinal before blaming the cell.

Never turn an unknown RPC state into a confirmed failure.

## `ValueAdded` exists

It is declared at `Matricies.sol:45` and does fire. It is missing from the ABI only because `addValue` is an `external` library function; the `DELEGATECALL` means the log is still emitted at the Zarya address, so a hand-written fragment subscribes to it. `x` and `y` are indexed.

It does **not** carry `isCategorical`, so it cannot say which matrix changed — disambiguate by reading `getCategoricalCellOrgan` / `getNumericalCellOrgan` at those coordinates. `setTheme`, `setStatement`, and `setDecimals` emit nothing, so those changes are observable only through creation events plus finalization.
