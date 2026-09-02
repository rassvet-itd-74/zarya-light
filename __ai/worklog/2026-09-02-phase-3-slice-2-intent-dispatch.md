# Phase 3 slice 2 — the dispatch to contract calls, and the simulator arm

## Ask

"Proceed from last we left off." Slice 1 left the intent union validated but with no route to the
chain: nothing had ever produced calldata. This slice is the two remaining Phase 3 bullets — the
exhaustive intent-to-call mapping with a `never` check, and the `CallSimulator` arm that takes the
union rather than bytes.

## Changes

**There are two closed unions now, and the second is not a restatement of the first.**
`GovernanceIntent` says what a document *asks for*; `ZaryaWriteCall` says what the contract *takes*.
Collapsing them would have meant an encoder doing three different jobs inline, and each is a place
something goes silently wrong:

- **Arity.** `CONFIGURE_ORGAN_THRESHOLDS` is one operation and three transactions.
- **Naming.** A categorical value proposal carries a `category`; `createCategoricalValueVoting` takes
  it as `value`. The rename happens once, in a switch arm with a comment, not at a call site.
- **Argument order.** `createStatementVoting(bool, uint256 x, uint256 y, string, uint256)` takes two
  `uint256` in a row. A swap type-checks, encodes, gates on the wrong column and writes the wrong
  row. Naming the arguments in a union means the order is asserted in one test instead of trusted
  everywhere.

**The call union stays in domain vocabulary.** An organ is a triple, a matrix is a `MatrixKind`, a
vote is a `VoteDirection`. Wire values appear only at the encoder, through the three conversions that
already existed in exactly one place each — `OrganResolver.resolve`, `isCategoricalOf`, `supportOf`.
So there is still no arithmetic or boolean route into an argument, one layer further down than
before.

**`executeVoting` is absent from the call union as well as from the intent union.** That makes hard
rule 3 a type rather than a rule to remember: the form pipeline cannot express the executor's call,
and the executor will not be able to express anything else, because its call type is disjoint. The
cost is named rather than hidden — Phase 6's queue takes a union of two call types and Phase 7 owes
the second one.

**`forIntent` has a third result arm.** `WOULD_SUCCEED` / `FAILED` was not enough once organ
resolution became part of building the call: a resolution that did not answer is not something the
contract decided. `NOT_ATTEMPTED` carries three reasons, split by retry behavior —
`ORGAN_UNREADABLE` (transport, reconcile later), `ORGAN_MISMATCH` (the contract answered and
disagreed; retrying repeats it exactly and a human has to look), `NOT_ENCODABLE` (this client's bug
or the wrong deployment). Flattening the first two would have put an unresolvable configuration error
into a retry loop.

`FAILED` names the **step** and stops there. The steps are simulated sequentially rather than in
parallel, so the reported step is the one that would actually stop the sequence rather than whichever
request lost a race.

## The threshold ordering is conditional, and finding out why took reading the snapshot

The plan said "it expands to three, and the ordering is the dispatcher's decision" without saying
what decides it. What decides it is that **eligibility is snapshotted at voting creation**: each
`create*Voting` calls `_getEligibilityParams` and copies all three values into the voting
(`Zarya.sol:497-503`). A voting created between two of the setter transactions therefore keeps the
half-applied thresholds *for its whole life*, and no getter exists to show it. The window is seconds;
what it produces is permanent.

Base **last** is right for enabling a configuration: the first two writes are inert while the base is
zero, so on any organ that has never been configured the whole thing goes live in one transaction.

Base last is *wrong* for the reset, and that is the part that was not obvious. Resetting all three to
zero with the base last passes through quorum `0` **and** approval `0` against a still-live base —
which `CONTRACT_DEFECTS.md` already lists as "one *for* vote passes". A reset would open a window
strictly more permissive than either the old configuration or `simpleMajority`. Base **first** on a
reset means the organ reads as `simpleMajority` from the first transaction on, and the two writes
that follow are inert.

Both writes are still sent on a reset, so a later base-only configuration cannot resurrect a quorum
nobody asked for.

**What this does not fix, stated rather than papered over:** changing thresholds on an organ that
already has a non-zero base. The first transaction changes what a new voting snapshots, and no
ordering of three writes avoids it — the fix is a fourth transaction zeroing the base first so every
intermediate state is a complete configuration, which trades a mixed configuration for a temporary
*downgrade* to the default. That is a governance decision rather than a dispatch one, so the
dispatcher does not make it and the three-transaction form ships. Recorded as a new subsection of
"The approval base doubles as an enable flag".

## The test that earns its place

`writeCallData.test.ts` does not assert selectors. A selector proves the name and the types, and the
mistake worth catching is an `x`/`y` swap, which changes neither. So every arm is encoded and then
**decoded back through the same ABI**, and the decoded arguments are compared by the ABI's own
argument *names*:

```ts
const { functionName, args } = decodeFunctionData({ abi: ZARYA_ABI, data });
const item = getAbiItem({ abi: ZARYA_ABI, name: functionName }) as AbiFunction;
item.inputs.forEach((input, index) => { named[input.name] = args[index]; });
```

The fixtures are built for it: coordinates are `(3, 7)` rather than `(1, 1)`, and the member and the
value author are different addresses, because an order test on equal values passes either way round.

The sweep over all thirteen arms is also what discharges the one thing the types cannot check — the
two lists in `organOfCall` and `argumentsFor` have to agree. An arm using `organ` without
`organOfCall` naming it passes `undefined` where a `bytes32` belongs, viem refuses it, and the call
comes back `NOT_ENCODABLE` in that test rather than in production.

## Also done

- **The eleven intent fixtures were extracted** to `domain/intents/testing/intentSamples.ts`, keyed by
  `OperationType` with each value narrowed to *that* variant. Three suites needed the same eleven, and
  eleven literals copied per suite is how one of them ends up testing a variant the others do not
  have. A twelfth operation type is now a missing-property error there and every sweep gains a case
  at once.
- **`ZaryaCallSimulator` takes an `OrganResolver`**, required rather than optional. Its one
  construction site (`preflight.fork.test.ts`) already built one.
- **A stale comment in `buildIntent.ts`** still said the project does not run `strict`. It has since
  slice 1 turned it on.

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
 Test Files  44 passed (44)
      Tests  550 passed (550)

$ npm run ai:validate
AI package OK — 16 skills, 47 documents (16 worklog), 4315 lines,
71 ABI and 1076 source symbols cross-checked.
```

Up from 41 files / 511 tests. New: `intentCalls` (13), `writeCallData` (18), `callSimulator` (8).
`ZARYA_FORK_RPC_URL` was set, so the four fork suites ran — 34 tests against the real deployment,
including `preflight.fork.test.ts` with the changed constructor.

## Unverified

- **No intent has been simulated against the real contract.** `forIntent` is covered by a stub node
  only. The fork suites still exercise `castVote` and `executeVoting` through the older arms, so the
  encoding of the eleven creation and configuration calls has been checked against the **ABI** and
  never against the deployed bytecode. A fork test that simulates a proposal as a real member is the
  obvious next check and was not written here.
- **The threshold ordering has never been observed.** The reasoning rests on reading
  `_getEligibilityParams` and the creation paths; nothing has created a voting between two setter
  transactions and read back what it snapshotted — and there is no getter that could.
- **`NOT_ENCODABLE` is unreachable through validation.** Every width the ABI cares about is already
  bounded in `fields.ts` and `fixedPoint.ts`, so the arm is a backstop tested only by constructing a
  call directly. If it ever fires in production, validation has a hole.
- **Nothing consumes the dispatch yet.** No preflight path calls `forIntent`, no queue exists, and
  nothing is wired to the worker, IPC, or the renderer. `npm start` was not run; worker protocol
  stays at v2.
- **The `VotingRef` single arm now has a second consumer.** `callsForIntent` reads
  `intent.voting.votingId` directly, so adding the symbolic arm is a compile error there too — which
  is intended, but it means the batch engine's dependency work touches this file.
