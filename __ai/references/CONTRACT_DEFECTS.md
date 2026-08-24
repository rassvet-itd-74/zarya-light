# Contract defects

Behaviors in the contract that the client must design around. Read from `temporal_docs/Zarya.sol` and its libraries, which match the ABI's external surface exactly — `npm run ai:validate` re-checks that on every run, including argument counts.

These are **not** documentation mismatches; see `DOCUMENTATION_STATUS.md` for those. They are things the contract does that the product documentation does not anticipate. None can be fixed client-side. Each entry says what the client must do anyway.

**Reference these by name, not by number.** Entries get fixed and removed, and numbered citations across a dozen files rot the moment one does.

> The authority for deployed behavior is the deployed bytecode, not this source tree. `contracts/Zarya.json` is a build artifact, not proof of what is live at the configured address. Where a defect is cheap to confirm against Sepolia, the confirmation is named.

## Fixed on 2026-08-24

Four earlier entries are resolved in the current source. Recorded here because the old behavior shaped code and docs that may still exist, and because "this was once broken" is worth knowing when reading a test.

| Was | Now |
| --- | --- |
| `approvalPercentageBase` had no setter, so six of eight voting types could never pass | `setMinimumApprovalPercentageBase` added (`Zarya.sol:288`), plus a `simpleMajority` fallback for unconfigured organs (`Zarya.sol:496-504`). All eight types can pass — but read **The approval base doubles as an enable flag** below |
| `castVote`'s `organ` argument was never compared to the voting's organ, so any member of any organ could vote on anything | The argument is gone. `castVote(votingId, support)` reads the voting's own `governingOrgan` and checks membership in that (`Zarya.sol:272-278`) |
| Zero votes with a zero quorum divided by zero and raised `Panic(0x12)` | Guarded by `results.totalVotes == 0 ||` (`Votings.sol:429`). It now reverts `InsufficientVotes` cleanly — still permanent, see below |
| `votingId == 0` passed the existence guard and reads returned zero-values | Rejected: `if (votingId == 0 || votingId > nextVotingId)` (`Zarya.sol:565-567`) |

Alongside them, `simpleMajority` moved from `{1, 50, 100}` to `{1, 5000, 10_000}` — basis points. The threshold is the same strict 50%, but integer division at base 100 truncated with up to 1% error, which could fail a borderline vote that should have passed; at base 10 000 the error is 0.01%. **Do not "simplify" this back to percent**, and do not render `5000` as a percentage without dividing by the base. Preserve the unit the contract reports.

The `castVote` change is a **breaking ABI change**. Any generated call site built against the three-argument form sends malformed calldata. The validator's arity check now catches this class of drift.

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

Quorum failure — and now zero votes, which routes here instead of panicking — **reverts** and leaves `finalized == false`. The voting is then past its `endTime`, so `isVotingActive` and `isVotingFinalized` are both false, forever. Every future `executeVoting` call reverts identically.

Fixing the panic made the error clean but did not make the voting executable. If anything the affected population grew: zero-vote votings now land here rather than in a distinct panic.

Approval failure **finalizes** with `success = false` and is terminal in the ordinary way.

**What the client must do:** classify `InsufficientVotes` as **terminal**, never retryable. Because such a voting stays unfinalized, the executor's discovery projection surfaces it as a candidate on every reconciliation pass, so it must be recorded locally as terminally unexecutable. This is the one case where local state must suppress what chain state keeps offering.

`FINALIZED_REJECTED` is reachable only through the approval path. See `STATE_MACHINES.md`.

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

Walk through what a Chairman configuring an organ to need 10 voters and 66% approval actually gets:

| Step | Stored for that organ | What a new voting snapshots |
| --- | --- | --- |
| start | `{0, 0, 0}` | `simpleMajority` → `{1, 5000, 10000}` |
| `setMinimumQuorum(organ, 10)` | `{10, 0, 0}` | still `simpleMajority` — base is 0 |
| `setMinimumApprovalPercentage(organ, 6600)` | `{10, 6600, 0}` | **still `simpleMajority`** — base is still 0 |
| `setMinimumApprovalPercentageBase(organ, 10000)` | `{10, 6600, 10000}` | `{10, 6600, 10000}` — now it applies |

Two transactions succeeded and changed nothing observable. The organ kept a quorum of 1 and a 50% threshold while its stored values said 10 and 66%. The third transaction then activates values written earlier, so the *effective* configuration changes without anyone writing a quorum in that transaction.

Because there is no eligibility getter, none of these rows can be read back. A Chairman cannot tell which one they are in.

The fix is contract-side and small: default only the missing field —

```solidity
if (params.approvalPercentageBase == 0) {
    return VotingEligibilityParameters({
        quorum: params.quorum,                        // keep what was configured
        approvalPercentage: params.approvalPercentage,
        approvalPercentageBase: simpleMajority.approvalPercentageBase
    });
}
```

— or keep an explicit `configured` flag per organ, so "unset" and "deliberately zero" stop being the same state.

The combinations, all reachable and none observable:

| Configured | Effective |
| --- | --- |
| nothing | `simpleMajority` — quorum 1, 50% strict |
| quorum and/or approval, **no base** | `simpleMajority`. The configuration is ignored |
| base only | quorum 0 → any single vote meets quorum; approval 0 → **one "for" vote passes**. Extremely permissive |
| all three | as configured |
| base set back to `0` | resets the organ to `simpleMajority`, discarding the other two |

**What the client must do:** never present per-organ threshold configuration as three independent settings. If the UI offers them, set the base whenever either other value is set, and treat "base = 0" as "organ not configured" rather than "base of zero". There is still **no getter** for per-organ eligibility, so the client cannot read back whether an organ is configured or verify that a write took effect — a configuration screen cannot show current state, only submit new state.

Order of operations matters and is invisible. Prefer submitting all three together as one operation.

## A region has two representations, and only one is the argument

**High, because the failure is silent and produces valid-looking wrong writes. Unchanged — `Regions.sol` was not touched.**

A region appears in two forms, and both are real:

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

So there is no way to pass `"74"` to `getPartyOrgan` — the parameter is `uint8`. What you pass is an ordinal, and `toString` decides which code string that ordinal becomes.

**The trap is that the two numbers are not the same number.** `toString` is a 98-branch lookup, not an arithmetic conversion, and the ordinal differs from the subject code for 50 of the 98 regions. Passing a subject code where an ordinal is meant does not usually revert — it addresses a *different real region*:

| Intended | Correct ordinal | Subject code | Passing the code addresses |
| --- | --- | --- | --- |
| Chechen Republic | 20 | `95` | Lugansk People's Republic |
| Krym Republic | 22 | `82` | Moscow (code 97) |
| Permsky Krai | 24 | `59` | Pskovskaya Oblast |

Only Moscow 99 and Saint Petersburg 98 have codes beyond the enum bound and would revert `UnknownRegion`. The other 96 resolve to something.

**The trap is worse than a plain off-by-one:** `CHELYABINSKAYA_OBLAST` is ordinal **74** and its subject code is **"74"**. They coincide. The project's primary region works under either interpretation, so any test written against `74` passes while half the country resolves to the wrong organ.

**What the client must do:** carry the enum ordinal in the domain model and treat the subject code as a display string only. Never accept a subject code where an ordinal is expected, including from a form field — a form asking for a region maps its answer through a table rather than passing the number through. Verify with `getPartyOrganIdentifier`, which is `pure`: the label contains the subject code, so a mismatch against the code you expected is detectable. Check on every organ resolution, not once at startup.

## A voting's governing organ has no getter

**Medium. New consequence of the `castVote` fix.**

Moving the organ into stored state was the right fix. The consequence is that the client now needs a value it cannot read: `governingOrgan` is a field of an `internal` struct, there is no `getVoting`, and none of the ABI's 43 functions returns a voting's organ.

**Why the client wants it.** To show a list of votings and mark which ones this member may vote on, it needs, per voting, the organ — then `isMember(organ, signer)`. That answers "can I vote", and also "why not", and lets the UI name the organ (`74.СОВ`) instead of just refusing.

Without a getter there are two options, and both have costs:

- **Simulate `castVote`** and see whether it reverts `NotActiveMember`. One RPC round trip per voting per render, and it returns a yes/no without telling you *which* organ decides — so the UI cannot explain the refusal or display the organ.
- **Index the creation events**, which do carry the organ: `MembershipVotingCreated`, `MembershipRevocationVotingCreated`, `CategoryVotingCreated`, `DecimalsVotingCreated`, `CategoricalValueVotingCreated`, `NumericalValueVotingCreated`. `ThemeVotingCreated` and `StatementVotingCreated` carry none, correctly reflecting that those votings have no organ.

The second is the right answer and is what to build. But it makes the event projection **load-bearing for vote preflight**, not just for deadline discovery and the matrix index — so a fresh client must backfill logs from the deployment block before it can answer a question about voting 1, and a projection with a gap (provider log-range limits, pruned logs, a dropped range) has votings whose organ is unknown.

**The failure mode is what makes this worth a getter.** "No organ" is a meaningful value — it means *anyone may vote*. So an unknown organ must never default to absent: that would tell a non-member they are eligible, and they would sign a transaction that reverts. Treat a missing projection entry as **eligibility undetermined**, and simulate.

A one-line `getVotingOrgan(uint256) view returns (bytes32)` removes the backfill requirement for this purpose, removes the gap risk, and lets the UI name the organ. It is the cheapest of the open items to fix.

## Smaller quirks

Not defects to design around, but surprises worth knowing before reading the source. All in `Matricies.sol`, which was not modified, except where noted.

- **Statements are keyed by `y` alone.** `setStatement(isCategorical, x, y, statement)` validates that a theme exists at `x` but writes to `statements[isCategorical][y]` (`Matricies.sol:168-181`), and `getStatement` reads by `y` only. The `x` argument is a gate, not part of the address. A later statement voting at a different `x` but the same `y` overwrites.
- **Cell organ ownership is first-writer-wins and permanent.** The first successful write binds the cell to an organ; a later write with a different organ reverts `InvalidOrgan` (`Matricies.sol:98-104`). There is no rebinding path. Now reachable, since value and category votings can pass.
- **`get*ValueAtTimestamp` returns the timestamp you asked for**, not the checkpoint's (`Matricies.sol:398-413` stamps the query value into the result). Do not display it as "when this value was set" — use `get*ValueAt` or the history readers.
- **`get*ValueAt` reverts out of bounds.** It indexes the checkpoint array directly, so bound the index by `get*SampleLength` first; an overrun is `Panic(0x32)`, not a custom error.
- **A zero encoded checkpoint reads as absent.** `get*ValueAtTimestamp` treats `encodedValue == 0` as not-found, which collides with a genuine value of `0` authored by `address(0)`. `valueAuthor` is caller-supplied and never validated against zero.
- **`duration` is unbounded.** `endTime = block.timestamp + duration`, no floor or ceiling. `duration == 0` yields a voting votable only inside its creating block. Bound it in client preflight.
- **`CannotRemoveChairman` is checked at creation, not at execution** (`Zarya.sol:98`). A member who becomes Chairman after a revocation voting was created would still be removed by it. Now reachable, since membership votings can pass.
- **`UnauthorizedAccess`** (`Votings.sol:114`) is still declared and never raised, so it stays absent from the ABI.
