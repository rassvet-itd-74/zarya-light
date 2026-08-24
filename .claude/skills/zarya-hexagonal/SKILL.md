---
name: zarya-hexagonal
description: Apply hexagonal (ports and adapters) architecture to Zarya — keeping the domain core free of Electron, chain, PDF, and storage dependencies, defining ports the domain owns, writing adapters that implement them, and enforcing the dependency direction. Use when adding any module, choosing where code belongs, introducing a library, or reviewing a boundary violation.
---

# Zarya hexagonal architecture

One rule underneath everything: **dependencies point inward.** The domain core defines what it needs; adapters supply it. The core never knows what supplies it.

The concrete port inventory and directory layout are in `__ai/references/ARCHITECTURE.md`. This skill is the discipline for working within them.

## Why this shape, here

- **No libraries are chosen yet** — no chain library, no PDF library, no database. Ports let the domain be written and tested now, and defer those decisions.
- **A pure domain is testable with no infrastructure at all.** Vitest arrived with Phase 1 and the domain's tests need no chain, no PDF, and no Electron. The same trick works one layer out: keeping the impure wiring separate made the window options, the CSP, and the IPC handlers testable too.
- **The contract has defects the client must absorb** (`__ai/references/CONTRACT_DEFECTS.md`), and they will be fixed contract-side eventually. Outcome classification, region encoding, and the error registry are adapter concerns; when the contract changes, so do they, and the domain does not.
- **The untrusted-form rule becomes structural.** The domain has no PDF type, so it *cannot* read a form field even by mistake.

That last point generalises into the principle worth carrying: prefer making an invariant impossible to violate over documenting that it must not be.

## What belongs in the core

Pure decisions, no I/O:

- the intent union, its schema validation and normalization
- organ representation as a structured triple
- semantic operation identity and conflict rules
- batch, item, and executor state machines
- executor candidate classification and outcome classification
- eligibility and threshold semantics as understood rules

The core takes validated data in and returns decisions out. It never awaits a network call it initiated itself — it asks a port.

## What belongs in an adapter

Everything that touches the world: the chain library, the PDF library, storage, Electron, the filesystem, the clock, randomness.

An adapter **translates**; it does not decide. Decoding `InsufficientVotes` from calldata is translation. Deciding whether that outcome is retryable is a domain decision. If an adapter contains a governance rule, the rule is in the wrong place.

## Ports are named for the need, not the technology

```ts
// The domain owns this. It says what the domain needs.
interface VotingReader {
  isFinalized(votingId: VotingId): Promise<boolean>;
  results(votingId: VotingId): Promise<VoteResults>;
}
```

Not `EthersVotingAdapter`, not `SqliteStore`. The implementation carries the technology name; the port carries the purpose. If you cannot name a port without naming a library, the boundary is in the wrong place.

Ports are declared in the domain and implemented outside it. That inversion is the whole point.

## The `Clock` port earns special mention

Deadlines must use **chain block timestamps**, never workstation time. Make that a port:

```ts
interface Clock {
  chainTime(): Promise<UnixSeconds>;
}
```

With a port, using wall-clock time in a deadline decision requires importing something the domain forbids, so lint catches it. Without one, it is a one-character mistake producing a subtly wrong executor. Same reasoning for `IdGenerator` — `operationRef` generation must be injectable, or issuance is untestable.

## Enforcement

`.eslintrc.json` carries an override restricting imports inside `src/domain/**`: no `electron`, no chain or PDF or storage library, no `node:*`, no reaching into `adapters/` or `app/`. It is inert until `src/domain/` exists, then applies immediately — do not weaken it to make an import work. A domain module that needs `node:crypto` needs a port instead.

Run `npm run lint` after any change that moves code across a boundary.

## Anti-patterns

- A library type in a domain signature — `Contract`, `Provider`, `PDFDocument`, `Buffer`, `Database`. Language primitives including `bigint` are fine.
- The domain importing `src/chain/abi/Zarya.abi.json`. The ABI is an adapter detail.
- A config module that the domain imports and that itself imports a library.
- An adapter that validates business rules, or a domain that formats a user-facing string.
- A port with one implementation and a shape mirroring that implementation exactly — that is a wrapper, not a boundary. Ask what the second implementation is; "the test fake" is a legitimate answer.
- Ports invented ahead of a need.

## Testing follows the shape

Domain: unit tests with in-memory fakes, no network, no temp files. Adapters: integration tests against the real thing — a local chain node, a temporary database, a real PDF round trip. Use cases: real domain wired to fake adapters, asserting the orchestration.

If a domain test needs a fake with interesting behavior, the logic probably belongs in the domain rather than behind the port.
