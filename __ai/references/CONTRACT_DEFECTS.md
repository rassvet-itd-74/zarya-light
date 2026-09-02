# Contract defects

Behaviors in the contract that the client must design around. Read from `temporal_docs/Zarya.sol` and its libraries, which match the ABI's external surface exactly — `npm run ai:validate` re-checks that, including argument counts.

These are **not** documentation mismatches; see `DOCUMENTATION_STATUS.md` for those. None can be fixed client-side. Each entry says what the client must do anyway.

**Reference these by name, not by number.** Entries get fixed and removed, and numbered citations across a dozen files rot the moment one does.

> The authority for deployed behavior is the deployed bytecode, not this source tree. Where a defect is cheap to confirm against Sepolia, the confirmation is named.

## Fixed on 2026-08-24

Four earlier entries are resolved in the current source. Recorded because the old behavior shaped code and docs that may still exist.

| Was | Now |
| --- | --- |
| `approvalPercentageBase` had no setter, so six of eight voting types could never pass | `setMinimumApprovalPercentageBase` added (`Zarya.sol:288`), plus a `simpleMajority` fallback for unconfigured organs (`Zarya.sol:496-504`). All eight types can pass — but read **The approval base doubles as an enable flag** below |
| `castVote`'s `organ` argument was never compared to the voting's organ, so any member of any organ could vote on anything | The argument is gone. `castVote(votingId, support)` reads the voting's own `governingOrgan` and checks membership in that (`Zarya.sol:272-278`) |
| Zero votes with a zero quorum divided by zero and raised `Panic(0x12)` | Guarded by `results.totalVotes == 0 ||` (`Votings.sol:429`). It now reverts `InsufficientVotes` cleanly — still permanent, see below |
| `votingId == 0` passed the existence guard and reads returned zero-values | Rejected: `if (votingId == 0 || votingId > nextVotingId)` (`Zarya.sol:565-567`) |

Alongside them, `simpleMajority` moved from `{1, 50, 100}` to `{1, 5000, 10_000}` — basis points. The threshold is the same strict 50%, but integer division at base 100 truncated with up to 1% error, which could fail a borderline vote that should have passed; at base 10 000 the error is 0.01%. **Do not "simplify" this back to percent**, and do not render `5000` as a percentage without dividing by the base.

The `castVote` change is a **breaking ABI change**. Any generated call site built against the three-argument form sends malformed calldata. The validator's arity check catches this class of drift.

## Quorum failure is permanent

**High. Determines the executor's retry design. Unchanged.**

`executeVoting` (`Votings.sol:416-445`) finalizes on exactly one path, and two failure paths leave the voting unfinalized forever:

```solidity
if (isActive(self)) revert VotingStillActive(self.id);
if (self.finalized) revert VotingAlreadyFinalized(self.id);
if (results.totalVotes == 0 || results.totalVotes < self.eligibilityParameters.quorum) {
    revert InsufficientVotes(results.forVotes, results.againstVotes);   // <- finalized stays false
}
// ... approval test ...
self.finalized = true;                                                  // <- only path that finalizes
```

Quorum failure — and now zero votes, which routes here instead of panicking — **reverts** and leaves `finalized == false`. The voting is then past its `endTime`, so `isVotingActive` and `isVotingFinalized` are both false, forever. Every future `executeVoting` call reverts identically. Fixing the panic made the error clean but did not make the voting executable; if anything the affected population grew.

Approval failure **finalizes** with `success = false` and is terminal in the ordinary way.

**What the client must do:** classify `InsufficientVotes` as **terminal**, never retryable. Because such a voting stays unfinalized, the executor's discovery projection surfaces it as a candidate on every reconciliation pass, so it must be recorded locally as terminally unexecutable. This is the one case where local state must suppress what chain state keeps offering.

`FINALIZED_REJECTED` is reachable only through the approval path. See `STATE_MACHINES.md`.

**Confirmed on the deployed contract, 2026-09-01.** Voting 1 — the only one that exists — is a membership voting created at block 11553481 with a 120-second duration and **zero votes cast**. It reads `isVotingActive: false, isVotingFinalized: false`, and simulating `executeVoting(1)` on a Sepolia fork reverts `InsufficientVotes(0, 0)`. The voting is past its deadline, unfinalized, and stays that way after the attempt. This defect is no longer inferred from source; `votingReader.fork.test.ts` asserts it.

## An approved voting can be permanently unexecutable

**High. The second class of permanent unexecutability, and the worse one — this voting *passed*. Found 2026-09-01 while implementing preflight.**

`executeVoting` applies the approved mutation **before** it marks the voting finalized (`Votings.sol:436-442`):

```solidity
success = approvalPercentage > self.eligibilityParameters.approvalPercentage;

if (success) {
    _executeApprovedSuggestion(self, membersRegistry, matricies);   // <- can revert
}

self.finalized = true;                                             // <- never reached if it does
```

There is no `try`. If applying the suggestion reverts, the whole transaction reverts, `finalized` stays `false`, and the voting joins the quorum-failed ones: past its deadline, unfinalized, and re-offered by discovery on every pass. The difference is that this one met its quorum and won its vote. The members decided, and the decision is discarded.

Five of the eight suggestion types can fail this way:

| Suggestion | Applied by | Reverts with |
| --- | --- | --- |
| `Statement` | `setStatement` | `NoThemeSet` — no theme at `x` |
| `Category` | `addCategory` | `InvalidOrgan`, `CategoryAlreadyExists` |
| `Decimals` | `setDecimals` | `InvalidOrgan` |
| `CategoricalValue` | `addValue` | `NoThemeSet`, `NoStatementSet`, `InvalidCategory` |
| `NumericalValue` | `addValue` | `NoThemeSet`, `NoStatementSet`, `InvalidOrgan` |

`Membership` and `MembershipRevocation` call `EnumerableSet.add` / `.remove` and discard the return, and `setTheme` is a bare assignment, so those three cannot fail.

**None of these conditions is checked at creation.** Creating a value voting checks `onlyMember(organ)` and nothing else — not the theme, not the statement, not the cell's binding. So the gap between "this proposal is well-formed" and "this proposal can be applied" is the entire voting period.

Two of the errors are **not in the ABI** (`NoThemeSet`, `NoStatementSet`, `InvalidCategory` are raised from `external` library functions), so an executor without the hand-registered fragments sees an undecodable selector rather than a reason.

**Recoverability is not uniform, and that distinction matters more here than anywhere else in the error registry:**

- `NoThemeSet`, `NoStatementSet`, `InvalidCategory`, `CategoryAlreadyExists` — **recoverable in principle.** Another voting can set the theme, set the statement, or add the category, and the stuck voting then executes. It is not retryable *on a timer*, but it must not be suppressed forever either.
- `InvalidOrgan` — **permanent.** Cell binding is first-writer-wins with no rebinding path.

**What the client must do:**

1. **Check the preconditions when the proposal is written**, which is the only moment they can still be fixed cheaply. `domain/preflight/applicationPreflight.ts` does this and reports it as a *warning*, not a refusal — creation genuinely will succeed, and the state can change before execution.
2. Do not let the executor treat a recoverable application failure as terminal, and do not let it retry one every poll either. Phase 7 owes this its own state, distinct from the `InsufficientVotes` suppression.
3. Never report such a voting as rejected. It was accepted; it is stuck.

The contract-side fix is to set `finalized = true` before applying, or to apply inside a `try`, so a voting's outcome is recorded even when its effect cannot be.

## The approval base doubles as an enable flag

**High, and new with the fix. Silent misconfiguration.**

The fallback that made organ votings work reads:

```solidity
function _getEligibilityParams(PartyOrgan organ) internal view returns (VotingEligibilityParameters memory) {
    VotingEligibilityParameters storage params = _votingEligibilityParametersByOrgan[organ];
    if (params.approvalPercentageBase == 0) return simpleMajority;   // Zarya.sol:502
    return params;
}
```

The guard tests **one** field and, on that basis, discards **all three**. It returns `simpleMajority` in its entirety — not just a default base.

What a Chairman configuring an organ to need 10 voters and 66% approval actually gets:

| Step | Stored for that organ | What a new voting snapshots |
| --- | --- | --- |
| start | `{0, 0, 0}` | `simpleMajority` → `{1, 5000, 10000}` |
| `setMinimumQuorum(organ, 10)` | `{10, 0, 0}` | still `simpleMajority` — base is 0 |
| `setMinimumApprovalPercentage(organ, 6600)` | `{10, 6600, 0}` | **still `simpleMajority`** — base is still 0 |
| `setMinimumApprovalPercentageBase(organ, 10000)` | `{10, 6600, 10000}` | `{10, 6600, 10000}` — now it applies |

Two transactions succeeded and changed nothing observable. The third then activates values written earlier, so the *effective* configuration changes without anyone writing a quorum in that transaction. Because there is no eligibility getter, none of these rows can be read back.

The combinations, all reachable and none observable:

| Configured | Effective |
| --- | --- |
| nothing | `simpleMajority` — quorum 1, 50% strict |
| quorum and/or approval, **no base** | `simpleMajority`. The configuration is ignored |
| base only | quorum 0 → any single vote meets quorum; approval 0 → **one "for" vote passes**. Extremely permissive |
| all three | as configured |
| base set back to `0` | resets the organ to `simpleMajority`, discarding the other two |

**What the client must do:** never present per-organ threshold configuration as three independent settings. If the UI offers them, set the base whenever either other value is set, and treat "base = 0" as "organ not configured" rather than "base of zero". Order of operations matters and is invisible, so prefer submitting all three together as one operation. The client cannot read back whether a write took effect — a configuration screen can only submit new state.

The contract-side fix is small: default only the missing field rather than the whole struct, or keep an explicit `configured` flag per organ. See `zarya-solidity-governance`.

### The window between the three transactions is permanent for anything created in it

Eligibility is **snapshotted at voting creation**, not read at execution: each `create*Voting` calls `_getEligibilityParams` and copies the three values into the voting (`Zarya.sol:497-503`, and every creation path from `Zarya.sol:82` onward). So a voting created between two of the three setter transactions keeps the half-applied thresholds *for its whole life*, and no getter can show it. The window is seconds; the consequence is not.

That makes the order of the three a real decision, and `domain/intents/intentCalls.ts` makes it:

| Target base | Order sent | Why |
| --- | --- | --- |
| non-zero | quorum, approval, **base** | The first two are inert while the base is zero, so on an organ still in the fallback — every organ never configured — the whole configuration goes live in one transaction |
| zero (the deliberate reset) | **base**, quorum, approval | Base last would pass through quorum 0 *and* approval 0 against a still-live base, and that combination is `one "for" vote passes` from the table above. Base first means the organ reads as `simpleMajority` from the first transaction on |

The reset still sends the two inert writes, so that a later base-only configuration cannot resurrect a quorum nobody asked for.

**What this does not fix:** changing thresholds on an organ that *already* has a non-zero base. The first transaction then changes what a new voting snapshots, and no ordering of three writes avoids it. The only fix is a fourth transaction zeroing the base first, so every intermediate state is a complete `simpleMajority` — which trades a mixed configuration for a temporary *downgrade* to the default. Which is worse is a governance decision, so it is not made in the dispatcher; the three-transaction form is what ships.

## A region has two representations, and only one is the argument

**High, because the failure is silent and produces valid-looking wrong writes. Unchanged — `Regions.sol` was not touched.**

| Form | Where it lives | Example for Chelyabinsk |
| --- | --- | --- |
| **Enum ordinal** — a number | the `region` **argument**, typed `uint8` in the ABI (`enum Regions.Region`) | `74` |
| **Subject code** — a string | inside the identifier the contract builds, via `Regions.toString(region)` | `"74"` |

The call takes the number. The string is what the contract *renders that number into* on its way to the hash:

```solidity
// PartyOrgans.from — the string is produced internally, never passed in
string memory identifier = getPartyOrganIdentifier(organType, region, number);  // e.g. "74.СОВ"
return PartyOrgan.wrap(keccak256(abi.encodePacked(identifier)));
```

So there is no way to pass `"74"` to `getPartyOrgan` — the parameter is `uint8`.

**The trap is that the two numbers are not the same number.** `toString` is a 98-branch lookup, not an arithmetic conversion, and the ordinal differs from the subject code for 50 of the 98 regions. Passing a subject code where an ordinal is meant does not usually revert — it addresses a *different real region*:

| Intended | Correct ordinal | Subject code | Passing the code addresses |
| --- | --- | --- | --- |
| Chechen Republic | 20 | `95` | Lugansk People's Republic |
| Krym Republic | 22 | `82` | Moscow (code 97) |
| Permsky Krai | 24 | `59` | Pskovskaya Oblast |

Only Moscow 99 and Saint Petersburg 98 have codes beyond the enum bound and would revert `UnknownRegion`. The other 96 resolve to something.

**Worse than a plain off-by-one:** `CHELYABINSKAYA_OBLAST` is ordinal **74** and its subject code is **"74"**. The project's primary region works under either interpretation, so any test written against `74` passes while half the country resolves to the wrong organ.

**What the client must do:** carry the enum ordinal in the domain model and treat the subject code as a display string only. Never accept a subject code where an ordinal is expected, including from a form field — a form asking for a region maps its answer through a table. Verify with `getPartyOrganIdentifier`, which is `pure`: the label contains the subject code, so a mismatch against the code you expected is detectable. Check on every organ resolution, not once at startup.

## `nextVotingId` is the *last* id, not the next one

**Medium. Silent off-by-one in any paging fallback. Confirmed against the deployed contract 2026-09-01.**

The public state variable is named for the value it is about to produce, not the value it holds:

```solidity
uint256 public nextVotingId;                       // Zarya.sol:17
function _getNextVotingId() private returns (uint256) {
    return ++nextVotingId;                         // Zarya.sol:508 — pre-increment
}
if (votingId == 0 || votingId > nextVotingId) revert VotingNotFound(votingId);  // Zarya.sol:566
```

Because the increment happens **before** the value is returned, the stored number is the id just handed out. `votingExists` agrees: it rejects ids *greater than* `nextVotingId`, so `nextVotingId` is itself always a valid id whenever it is non-zero.

| Votings created | `nextVotingId()` | Valid ids |
| --- | --- | --- |
| none | `0` | none |
| one | `1` | `1` |
| five | `5` | `1..5` |

Two ways to get this wrong, both quiet:

- **Paging `1 .. nextVotingId - 1`** skips the newest voting — the one most likely to still be active, and the one a user just created.
- **Reading `1` as "none exist"** is wrong twice: an empty contract reports `0`, and `1` means exactly one voting exists. This client made that mistake and it survived a probe against Sepolia, because a deployment with one voting reports the same number a mis-modelled empty one would.

**What the client must do:** treat it as an **inclusive** upper bound, and name it something that says so. `VotingReader.highestVotingId()` exists for that reason — the contract's name is not repeated into this codebase, so the trap cannot propagate through call sites. Discovery still comes from events; this is only the paging fallback.

## A voting's governing organ has no getter

**Medium. New consequence of the `castVote` fix.**

Moving the organ into stored state was the right fix. The consequence is that the client now needs a value it cannot read: `governingOrgan` is a field of an `internal` struct, there is no `getVoting`, and none of the ABI's 43 functions returns a voting's organ.

**Why the client wants it.** To show a list of votings and mark which ones this member may vote on, it needs the organ per voting, then `isMember(organ, signer)`. That answers "can I vote", and "why not", and lets the UI name the organ (`74.СОВ`) instead of just refusing.

Two options without a getter:

- **Simulate `castVote`** and see whether it reverts `NotActiveMember`. One RPC round trip per voting per render, and it returns a yes/no without telling you *which* organ decides.
- **Index the creation events**, which do carry the organ: `MembershipVotingCreated`, `MembershipRevocationVotingCreated`, `CategoryVotingCreated`, `DecimalsVotingCreated`, `CategoricalValueVotingCreated`, `NumericalValueVotingCreated`. `ThemeVotingCreated` and `StatementVotingCreated` carry none, correctly reflecting that those votings have no organ.

The second is what to build. It makes the event projection **load-bearing for vote preflight**, not just for deadline discovery and the matrix index — so a fresh client must backfill logs from the deployment block before it can answer a question about voting 1, and a projection with a gap has votings whose organ is unknown.

**The failure mode is what makes this worth a getter.** "No organ" is a meaningful value — it means *anyone may vote*. So an unknown organ must never default to absent: that would tell a non-member they are eligible, and they would sign a transaction that reverts. Treat a missing projection entry as **eligibility undetermined**, and simulate.

## Smaller quirks

Not defects to design around, but surprises worth knowing before reading the source. All in `Matricies.sol`, which was not modified, except where noted.

- **Statements are keyed by `y` alone.** `setStatement(isCategorical, x, y, statement)` validates that a theme exists at `x` but writes to `statements[isCategorical][y]` (`Matricies.sol:168-181`), and `getStatement` reads by `y` only. The `x` argument is a gate, not part of the address. A later statement voting at a different `x` but the same `y` overwrites.
- **The public `isCategoryAllowed` is not the guard `addValue` applies.** There are two functions of that name in `Matricies.sol`. The one behind the getter takes `(x, y, category)` and tests set membership alone (`266-277`); the one `addValue` calls takes `(organ, x, y, category)` and tests `allowedCategories.contains(category) && cell.organ == organ` (`48-61`). So `isCategoryAllowed(x, y, c) == true` does **not** mean the value can be added — the organ half of the real check is invisible to the getter, and a preflight built on it alone approves a proposal that will revert. Read the cell's binding separately. A consequence: because the category guard runs before the organ guard, `InvalidOrgan` is **unreachable** on the categorical branch of `addValue` — an organ mismatch there reverts `InvalidCategory`, naming the category rather than the organ that actually caused it.
- **Cell organ ownership is first-writer-wins and permanent.** The first successful write binds the cell to an organ; a later write with a different organ reverts `InvalidOrgan` (`Matricies.sol:98-104`). There is no rebinding path. Now reachable, since value and category votings can pass.
- **`get*ValueAtTimestamp` returns the timestamp you asked for**, not the checkpoint's (`Matricies.sol:398-413`). Do not display it as "when this value was set" — use `get*ValueAt` or the history readers.
- **`get*ValueAt` reverts out of bounds.** It indexes the checkpoint array directly, so bound the index by `get*SampleLength` first; an overrun is `Panic(0x32)`, not a custom error.
- **A zero encoded checkpoint reads as absent.** `get*ValueAtTimestamp` treats `encodedValue == 0` as not-found, which collides with a genuine value of `0` authored by `address(0)`. `valueAuthor` is caller-supplied and never validated against zero.
- **`duration` is unbounded.** `endTime = block.timestamp + duration`, no floor or ceiling. `duration == 0` yields a voting votable only inside its creating block. Bound it in client preflight.
- **`CannotRemoveChairman` is checked at creation, not at execution** (`Zarya.sol:98`). A member who becomes Chairman after a revocation voting was created would still be removed by it. Now reachable, since membership votings can pass.
- **`UnauthorizedAccess`** (`Votings.sol:114`) is still declared and never raised, so it stays absent from the ABI.
