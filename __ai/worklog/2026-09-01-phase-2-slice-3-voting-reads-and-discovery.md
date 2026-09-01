# Phase 2 slice 3 — voting reads and discovery

## Ask

"Proceed further with the implementation." Slice 3 of Phase 2: the voting and membership reads, and
the `VotingCreated` projection that recovers what the contract does not expose — `endTime` and a
voting's governing organ. The `ValueAdded` fragment and preflight stay for slice 4.

One open question from the previous slice was decided rather than escalated: the block cursor wants
Phase 5 storage. **`CursorStore` is declared in the domain now with an in-memory adapter**, the same
shape `Clock` took in Phase 1. The cursor is a cache over chain state — losing it costs a backfill
and nothing else — so an in-memory implementation is a real one, not a stub, and the monotonicity
rule that belongs to the port is enforced regardless of what backs it.

## Changes

**The reads return `undefined`, never a plausible `false`.** One rule shapes `ZaryaVotingReader`
entirely: `false` and "could not tell" are different facts, and conflating them would let an RPC
hiccup read as "not a member" — hiding a privilege — or "not finalized" — queueing an execution
against a settled voting. `VotingNotFound` is treated the same way, except in `exists()`, which
returns `false` only on that decoded error and `undefined` for anything else.

**The `(active, finalized)` pair is classified, not consumed raw.** `isActive` turned out to be a
pure time window that never consults `finalized` (`Votings.sol:146-148`), so neither boolean means
anything alone. `AWAITING_EXECUTION` is the pair `(false, false)` — which is also where a
quorum-failed voting lives forever, indistinguishable from an unfinished one by chain state alone.

**`endTime` is inclusive, and that is an off-by-one worth a test.** The comparison is
`block.timestamp <= self.endTime`, so at exactly `endTime` the voting is still active and
`executeVoting` reverts `VotingStillActive`. `isExecutionDue` is strictly greater; a `>=` would have
queued a guaranteed revert once per poll, forever.

**`GoverningOrgan` is a tri-state and the third member is the point.** `NONE` means anyone may vote —
true for theme and statement votings, whose events carry no organ. `UNKNOWN` means the projection has
no detail event. Collapsing `UNKNOWN` into `NONE` would tell a non-member they are eligible, and they
would sign a transaction that reverts. `governingOrganFrom` decides which one applies from the
suggestion type, so absence is only ever an *answer* where the contract says it is.

**Discovery separates the window from the scan.** `planDiscovery` is pure and holds every rule that
keeps a projection correct: start at the deployment block, stay 12 confirmations behind the head,
cap a window at 5 000 blocks, and report `CURSOR_AHEAD` rather than deciding on its own whether to
rewind. The cursor means "everything up to and including this block is projected" and advances only
after a window is handled, so a crash mid-backfill re-scans rather than skips.

**The deployment block is `11553464`, found by binary search over `eth_getCode`**, not transcribed —
24 probes, and the block's timestamp is 2026-08-24T00:13:00Z, matching the redeploy date in
`DEPLOYMENT.md`. It is configuration, and `loadConfig` refuses to pair the default block with a
non-default address rather than backfilling from another deployment's history.

**Two corrections to things this slice got wrong first.**

- The discovery adapter originally hand-wrote the event fragments, on the belief that `Votings.sol`
  being a library kept them out of the ABI. It does not: those functions are `internal`, so solc
  inlines them and **all twelve events are in the ABI**. Only `Matricies`' `external` functions cause
  absence, which is why `ValueAdded` alone needs a fragment. Replaced with `requireEvent`, mirroring
  `requireFunction` — sourced from the ABI and asserted at load.
- `PublicConfig` gained `deploymentBlock` as a `bigint`, and the existing security test failed with
  "Do not know how to serialize a BigInt". That type crosses IPC and appears in logs, so a BigInt
  field would have broken the boundary at runtime. Now a `number` — block heights are nowhere near
  2^53 — widened at the chain call site. A test written for one reason caught a different real bug.

## Evidence

```text
$ npm run typecheck
> tsc --noEmit
(no output — clean)

$ npm run lint
> eslint --ext .ts,.tsx .
(no output — clean)

$ npm test
> vitest run
 Test Files  26 passed (26)
      Tests  318 passed (318)
```

Up from 20 files / 236 tests. New: `voting` (11), `votingLifecycle` (18), `discoveryPlan` (13),
`memoryCursorStore` (10), `votingDiscovery` (17), `votingReader.fork` (12).

**The deployed contract turned out to hold exactly one voting, and it is the most instructive one
possible.** Probing it produced the finding that reshaped this slice's tests:

```text
block 11553481  VotingCreated { votingId: 1, author: 0x57eb…3CfD,
                                startTime: 1787530584, endTime: 1787530704,
                                suggestionType: 0 }
block 11553481  MembershipVotingCreated { votingId: 1,
                                organ: 0x99e1c11f…29ecb5, member: 0x57eb…3CfD }

isVotingActive(1)     false
isVotingFinalized(1)  false
getVotingResults(1)   { for: 0, against: 0, total: 0 }
```

That organ hash is `keccak256("74.СОВ")` — the Chelyabinsk regional soviet — **the exact digest
slice 2 pinned as a literal**. The local mirror and the deployed library agree on a value neither
was written from.

And the voting itself is the "Quorum failure is permanent" defect, live: 120-second duration, zero
votes, past its deadline, never finalized. So `executeVoting(1)` was **simulated on the fork** —
`eth_call`, no signer, nothing broadcast — and reverts `InsufficientVotes(0, 0)`, classified
`TERMINAL` by the registry, with the voting still unfinalized afterwards. **This closes slice 2's
"`InsufficientVotes` is classified as terminal from source reading, not observed."**

All 12 fork assertions pass, including the full backfill: ~12 bounded windows from block 11553464 to
12 behind head, contiguous with no gaps, finding exactly voting 1 — the same result a single sweep
gives.

**One contract finding, promoted to the references.** `nextVotingId` holds the **last** id issued,
not the next: `_getNextVotingId` returns `++nextVotingId` (`Zarya.sol:508`), and `votingExists`
accepts ids up to and including it. An empty contract reports `0`. This client had it backwards, and
the mistake survived a direct probe of Sepolia — a deployment with one voting reports `1`, which is
exactly what a mis-modelled empty one would report. Only running the real reads against real state
exposed it. Recorded in `CONTRACT_DEFECTS.md`, `CONTRACT.md`, and `CLAUDE.md`; the port method is
named `highestVotingId` so the contract's misleading name stops at the adapter boundary.

## Unverified

- **The creation/detail join is proven on one real voting and otherwise on synthetic logs.** Both of
  voting 1's logs sit in the same block, so no honest window can split them — the `UNKNOWN` organ
  path, the mismatched-id path, and the malformed-log paths are all unit tests. Only creating votings
  on the fork would exercise the split for real.
- **No voting has ever been observed `ACTIVE` or `FINALIZED`.** The only one on chain is
  `AWAITING_EXECUTION`, so those two branches of `classifyVotingPhase` are asserted against
  constructed observations, not against the contract.
- **`hasVoted` has only ever returned `false`.** Nobody has voted on this deployment.
- **The reorg path is untested.** `CURSOR_AHEAD` is a unit test; no reorg has been simulated, and
  the 12-confirmation depth is a judgement about Sepolia, not a measurement of it.
- **The cursor does not survive a restart**, by construction. Phase 5 replaces the adapter; until
  then every start backfills ~60 000 blocks, which takes about a dozen requests and is why the
  window cap matters.
- **`planDiscovery`'s 5 000-block cap is untested against a provider that refuses a wider range.**
  The fork answers anything, so the cap is a precaution, not a measured limit.
- **Nothing is wired to the worker, IPC, or the renderer.** `npm start` was not run; worker protocol
  stays at v2. Discovery has no caller yet — that is Phase 7.
- **`npm run ai:validate` still breaks when `temporal_docs/` is deleted**, unchanged from the last
  slice and still a decision rather than a cleanup.
