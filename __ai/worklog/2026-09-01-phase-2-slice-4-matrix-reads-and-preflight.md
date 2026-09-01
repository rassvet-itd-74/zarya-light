# Phase 2 slice 4 — the `ValueAdded` fragment, matrix reads, and preflight

## Ask

"Analyze and proceed with the next phase." The two items left in Phase 2: the hand-written
`ValueAdded` fragment, and Chairman-aware preflight. The matrix metadata reads were not on the list
and were added anyway — preflight for a value proposal cannot be written without them, and the
`ValueAdded` disambiguation needs the same reads.

Phase 2 is complete with this slice.

## Changes

**The contract's authorization rules are five values, not scattered `if`s.** `AuthorizationRule` is
`PERMISSIONLESS`, `MEMBER_OR_CHAIRMAN`, `MEMBER_ONLY`, `CHAIRMAN_ONLY`, and a fifth that is not a
rule the contract has — `UNDETERMINED_ORGAN`, for a voting the projection is missing. Writing them
as data made the Chairman exemption checkable rather than remembered: `creationRule` is exhaustive
over the eight suggestion types, and the four matrix-configuration votings get `MEMBER_ONLY`,
because `onlyMember` calls `_onlyMember` and not `_onlyMemberOrChairman`. The tempting
generalization — "the Chairman can do anything" — is wrong for half the creation surface, and there
is now a test whose only job is to say so.

**A rule decides which reads to make, so an unusable answer is never even available.**
`needsChairmanRead` is false for `MEMBER_ONLY`, so the preflight service does not resolve the
Chairperson organ under that rule. That saves a round trip, but the reason it is written that way is
the other one: a Chairman flag sitting in scope where the contract grants no exemption is an
invitation.

**Preflight predicts a revert *name*, and the guard order is part of the prediction.** `castVote`
checks the voting's organ (`Zarya.sol:272-278`) before `Votings.castVote` ever tests `isActive`
(`Votings.sol:392`). So a non-member looking at an expired voting is refused for **membership**, not
for the deadline — and a preflight that checked the window first would name a revert the chain never
raises. `resolvePreflight` walks the guards in contract order. It also drops the predicted name when
an earlier guard could not be evaluated: the call still cannot succeed, but which error it raises is
no longer knowable, and saying so is cheaper than being caught guessing.

Predicting names rather than inventing client vocabulary means the disposition and the user-facing
wording come from the error registry slice 2 already built. `AlreadyVoted` reads as `ALREADY_DONE`
with no second opinion about it.

**The client's verdict and the simulation are reconciled, and the disagreement is kept.** The
simulation wins — it runs the deployed bytecode — but `reconcilePreflight` records *how* they
differed: `CLIENT_STRICTER` (refusing what the chain accepts, the costly direction),
`CLIENT_LOOSER`, or `PREDICTED_WRONG_ERROR`. A stale event projection has no other symptom, so
throwing the disagreement away would discard the only signal. The exception is an outage: `FAILED`
with an `UNKNOWN` outcome is the node not answering, and the client verdict stands, labelled
`CLIENT`. A `READY` the simulation could not confirm is withdrawn to `UNDETERMINED` rather than
presented as verified.

**`CallSimulator` names calls instead of taking calldata.** A `simulate(to, data)` port would be
smaller and would put a hole in the form trust boundary one layer below where anyone would look for
it — the whole point of the allow-listed intent model is that no document reaches arbitrary
calldata. Two arms for now, `castVote` and `executeVoting`; Phase 3 adds the rest. `from` is not
optional, because every guard in Zarya tests `msg.sender` and a simulation without one answers a
question about the zero address.

**The `ValueAdded` fragment is pinned by a topic hash, not only by the source.** It is the one
hand-written signature in this client. `temporal_docs/` leaves when the plan completes, so the
durable check is `keccak256("ValueAdded(uint256,uint256,uint64,address)")` as a literal, asserted at
module load against the fragment. The failure it guards is the quietest one available: a filter
built on a wrong topic matches nothing, and a projection whose job is completeness reports emptiness.
A test also shows the pin is *not* sufficient alone — topic hashes ignore `indexed`, so a wrong flag
survives it and is caught only against the declaration.

**Which matrix a `ValueAdded` belongs to is a tri-state, and `AMBIGUOUS` is the load-bearing member.**
The event carries no `isCategorical`, so attribution comes from reading both cells. The two matrices
are independent mappings over one coordinate space, so `(3, 7)` can be bound in both — and then no
read separates them. `attributeValue` also refuses to answer from one read even when that read is
`BOUND`, because the unread side could have made it ambiguous.

**`MatrixKind` and the zero organ are the two translations the adapter owns.** The contract keys the
pair of matrices on a bare `bool`, which is wrong silently — it addresses the other real matrix
rather than failing, the same shape of mistake as a subject code passed for a region ordinal. The
domain carries a named kind and `isCategoricalOf` is the only place it becomes a boolean. Separately,
every cell getter answers for every coordinate, and an unwritten cell answers 32 zero bytes; left as
a hash that would flow into an `isMember` call and report nobody as a member of nothing, so
`cellBinding` turns it into `UNBOUND` at the boundary.

**The duration bound is marked as this client's own.** It is the only refusal in preflight that is
stricter than Solidity, which normally is the wrong move, so it carries `CLIENT_POLICY` and no
predicted revert — nothing downstream can report it as something the contract said. It refuses the
deployment's own 120-second voting, which is the failure it exists to prevent, already on chain.

**One shared `callContract`.** Three copies of encode/call/decode was the threshold; `votingReader`
moved onto it and `matrixReader` and the simulator were written against it. `organResolver` keeps its
own, because it is supposed to throw on a mismatch rather than classify. The simulator needs
`callRaw` besides: `castVote` returns nothing, so a successful call comes back with empty returndata,
which the decoding path honestly cannot tell from an empty revert.

## Two contract findings, both promoted to the references

**An approved voting can be permanently unexecutable.** `executeVoting` applies the mutation
*before* it sets `finalized` (`Votings.sol:436-442`), with no `try`. If applying it reverts, the
whole transaction reverts and `finalized` stays false — so a voting that met its quorum and **won its
vote** joins the quorum-failed ones: past its deadline, unfinalized, re-offered by discovery forever.
This is the worse of the two classes, because the members decided and the decision is discarded.

Five of the eight types can fail there — statement, category, decimals, and both value types — and
**none of those conditions is checked at creation**, which only checks `onlyMember(organ)`. So the
gap between "well-formed proposal" and "applicable proposal" is the entire voting period, and the
only cheap moment to catch it is when the member fills in the form. That is what
`applicationPreflight.ts` does, and it reports *warnings* rather than refusals, because creation
genuinely will succeed and the missing theme may well be set by another voting in the meantime.

Recoverability is not uniform, and the distinction matters here more than anywhere else in the
registry: `NoThemeSet`, `NoStatementSet`, `InvalidCategory` and `CategoryAlreadyExists` can be
cleared by a later voting, while `InvalidOrgan` cannot. Phase 7 owes this executor state distinct
from the `InsufficientVotes` suppression — neither "retry every poll" nor "suppress forever" is right.

**The public `isCategoryAllowed` is not the guard `addValue` applies.** There are two functions of
that name in `Matricies.sol`. The getter takes `(x, y, category)` and tests set membership alone
(`266-277`); the one `addValue` calls takes `(organ, x, y, category)` and also requires
`cell.organ == organ` (`48-61`). A preflight built on the getter approves proposals that revert. A
consequence falls out of the ordering: because the category guard runs first, **`InvalidOrgan` is
unreachable on the categorical branch** — an organ mismatch there reverts `InvalidCategory`, naming
the category rather than the organ that actually caused it. `categoricalValueWarnings` predicts
`InvalidCategory` for that case and has a test asserting it is *not* `InvalidOrgan`.

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
 Test Files  37 passed (37)
      Tests  440 passed (440)

$ npm run ai:validate
AI package OK — 16 skills, 45 documents (14 worklog), 3885 lines,
71 ABI and 912 source symbols cross-checked.
```

Up from 26 files / 318 tests. New: `matrix` (11), `authorization` (17), `verdict` (11),
`votePreflight` (10), `applicationPreflight` (20), `durationPolicy` (6), `reconcilePreflight` (12),
`matrixEvents` (9), `matrixReader` (9), `preflightVote` (9), `preflight.fork` (8).

**The fork tests ran and the guard-order claim survived contact with the bytecode.** Against the
real deployment:

- `castVote(1, true)` simulated from `0x…dEaD` reverts **`NotActiveMember`**, not `VotingNotActive`,
  even though voting 1 is past its deadline. The client predicted `NotActiveMember`, and
  `disagreement` came back `undefined`.
- The same call simulated from voting 1's own author reverts `VotingNotActive` — the organ guard
  clears and the window guard does not. Also predicted, also no disagreement. The two senders
  getting different reverts from the same expired voting is the ordering, demonstrated rather than
  argued.
- `isMember(ПРЛ, author)` is `true`, so the deployment's Chairman is the address that created
  voting 1 — which is why that second case clears the organ guard.
- `executeVoting(1)` through the simulator port reverts `InsufficientVotes`, matching what slice 3
  observed through a raw call.
- `(0, 0)` reads `UNBOUND` in both matrices with both axes `UNSET`, and a value proposal there is
  warned as `NO_THEME_AT_COLUMN` + `NO_STATEMENT_AT_ROW` — the new defect predicted against real
  state, not a fixture.
- A `ValueAdded`/`CategoryAdded` scan across the whole deployment history finds nothing, consistent
  with the cell reads, and exercises the hand-written fragment against a live provider.

The record fed to preflight comes from `ZaryaVotingDiscovery.scan` over the real creation logs, not
from a literal — the governing organ it depends on exists nowhere else.

## Unverified

- **No preflight has ever returned `ALLOWED` and then been signed.** There is no signer in Phase 2,
  so the whole path is `eth_call`. `WOULD_SUCCEED` has been observed only for the `UNKNOWN`-organ
  case in unit tests; on the fork every simulation reverted, because the one real voting is expired.
- **`MEMBER_ONLY` and `CHAIRMAN_ONLY` are unit-tested only.** Nothing on this deployment exercises a
  matrix-configuration voting or a privileged setter, so the claim that the Chairman is *not* exempt
  from the four is read from source and asserted against constructed observations.
- **Every application-preflight warning is predicted, none observed.** The five reverts they predict
  have never been produced by the deployed contract, because no voting has ever reached the
  application step there. Confirming `NoThemeSet` end to end needs a voting created, voted, and
  executed on a fork — a write path this phase does not have.
- **`AMBIGUOUS` attribution is unreachable on this deployment**, which has no bound cells at all. It
  is asserted against constructed bindings.
- **The disagreement channel has never fired against the chain.** Every fork prediction matched, so
  `CLIENT_STRICTER` / `CLIENT_LOOSER` / `PREDICTED_WRONG_ERROR` are unit tests. That is the desired
  outcome and also means the detector itself is unproven in the field.
- **The duration bounds are a judgement, not a measurement.** One hour and one year are defensible
  and arbitrary; nothing about this deployment or its governance schedule was consulted.
- **`ValueAdded`'s topic is pinned but has never decoded a real log**, because none exists. The
  fragment's correctness rests on the literal hash and the source comparison.
- **`getCategoryName`, the checkpoint readers, and the history pager are not implemented.** They
  belong to the matrix report in Phase 4 and were deliberately kept out of `MatrixReader`.
- **Nothing is wired to the worker, IPC, or the renderer.** `npm start` was not run; worker protocol
  stays at v2. Preflight has no caller outside tests — the form pipeline is Phase 4.
- **`npm run ai:validate` still breaks when `temporal_docs/` is deleted** — and that is not a
  problem to solve yet. The user confirmed on 2026-09-01 that the sources **stay until every phase
  is done**, and may then be folded into documentation rather than deleted at all. So the
  source-derived tests keep their `hasSoliditySource` guards for the reason they were written — the
  fork sweeps and the literal digests are the stronger evidence either way — but nothing should be
  pulled forward to accommodate a removal that is not scheduled for this part of the plan. Earlier
  in this slice I suggested taking it before Phase 4; that was wrong.
