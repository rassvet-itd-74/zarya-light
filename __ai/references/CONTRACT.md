# Zarya contract surface

**Derived from `temporal_docs/Zarya.sol` and its libraries, cross-checked against `src/chain/abi/Zarya.abi.json`** — 1 constructor, 43 functions, 12 events, 16 custom errors in the ABI. Source and ABI agree exactly on the external surface, names and argument counts alike; `npm run ai:validate` re-checks that on every run.

Source outranks the ABI now that it is present, because it answers what the ABI cannot: authorization, comparison operators, and whether a failed check reverts or records. Behaviors that the product documentation does not anticipate are in `CONTRACT_DEFECTS.md` — **read it before designing the executor, organ resolution, or any UI that reports an outcome.** For stale documentation lines, `DOCUMENTATION_STATUS.md`. For network and address, `DEPLOYMENT.md`.

A round of contract fixes landed on 2026-08-24: `castVote` lost its organ argument, `setMinimumApprovalPercentageBase` was added, zero-vote execution and `votingId == 0` were guarded, and eligibility moved to basis points. `CONTRACT_DEFECTS.md` records what changed and what did not.

## Organ encoding

An organ is a **`bytes32`** — `keccak256` of the display identifier, derived from a triple:

```solidity
getPartyOrgan(uint8 organType, uint8 region, uint256 number) pure returns (bytes32)
getPartyOrganIdentifier(uint8 organType, uint8 region, uint256 number) pure returns (string)
```

Both are `pure`, so they cost no state read. Use `getPartyOrgan` for calls and `getPartyOrganIdentifier` for display.

**Do not hash a Cyrillic identifier string yourself.** The intent model carries the structured triple, not the label.

| Organ | Identifier | `PartyOrganType` | Uses region | Uses number |
| --- | --- | --- | --- | --- |
| Local soviet | `NN.X.СОВ` | `LocalSoviet` | yes | yes |
| Local general assembly | `NN.X.ОБС` | `LocalGeneralAssembly` | yes | yes |
| Regional soviet | `NN.СОВ` | `RegionalSoviet` | yes | no |
| Regional conference | `NN.КОН` | `RegionalConference` | yes | no |
| Regional general assembly | `NN.ОБС` | `RegionalGeneralAssembly` | yes | no |
| Chairman | `ПРЛ` | `Chairperson` | **ignored** | **ignored** |
| Central soviet | `СОВ` | `CentralSoviet` | **ignored** | **ignored** |
| Party congress | `СЗД` | `Congress` | **ignored** | **ignored** |

The last three ignore `region` and `number` entirely (`PartyOrgans.sol:75-80`), so `getPartyOrgan(Chairperson, r, n)` returns the same `bytes32` for every `r` and `n`. They are single global organs. Do not treat a differing region as a differing Chairperson organ.

`NN` is the region's **subject code** in the identifier string, but the `region` argument is the **enum ordinal**, and the two differ for 50 of 98 regions. Passing a subject code silently addresses a different real region — see "Region ordinals are not subject codes" in `CONTRACT_DEFECTS.md`. It is the single easiest way to write to the wrong organ.

### Chairman identity is readable after all

There is no `getChairman()`, but the Chairman is stored as a member of the Chairperson organ (`Zarya.sol:53-54`, `559-562`), so:

```solidity
isMember(getPartyOrgan(PartyOrganType.Chairperson, 0, 0), candidate)
```

is a Chairman check. Preflight for the privileged setters may check identity directly; it does not have to simulate and catch `NotChairman`. Simulation is still the honest answer for whether the *call* will succeed, since state can change between preflight and mining.

## Access control

Read from the modifiers and bodies in `Zarya.sol`. Preflight must match this exactly — anything stricter rejects calls the contract would accept.

| Guard | Functions |
| --- | --- |
| **none — permissionless** | `createThemeVoting`, `createStatementVoting`, `executeVoting`, every getter |
| member of the voting's own organ, **or** Chairman | `castVote` — but only when the voting has an organ; see below |
| member of the organ, **or** Chairman | `createMembershipVoting`, `createMembershipRevocationVoting` |
| member of the organ, Chairman **not** exempt | `createCategoryVoting`, `createDecimalsVoting`, `createCategoricalValueVoting`, `createNumericalValueVoting` |
| Chairman only | `initializeOrgans`, `setMinimumQuorum`, `setMinimumApprovalPercentage`, `setMinimumApprovalPercentageBase`, `transferChairmanship` |

Two things this table makes visible. The Chairman is **not** a universal override — it is exempt for membership votings and `castVote` but not for the four matrix-configuration votings. And `castVote` scopes properly to the voting's own organ, which it reads from stored state rather than accepting from the caller:

```solidity
PartyOrgan governingOrgan = _votings[votingId].governingOrgan;
if (governingOrgan != PartyOrgans.ZERO_PARTY_ORGAN) {
    _onlyMemberOrChairman(governingOrgan);
}
```

**Theme and statement votings have no organ**, so that check is skipped and anyone may vote on them. This is intentional — they are open votes on the matrix axes — but note the consequence: with `simpleMajority`'s quorum of 1, a single address can create a theme voting, vote for it, and execute it alone. Do not describe these operations as member-only in UI, and do not let a form schema imply an organ is required for them.

A failed member-or-Chairman check reverts `NotActiveMember(organ, caller)`. A failed Chairman-only check reverts `NotChairman(caller)`.

## Voting lifecycle

```solidity
// 1. create
createMembershipVoting(bytes32 organ, address member, uint256 duration) returns (uint256)
createMembershipRevocationVoting(bytes32 organ, address member, uint256 duration) returns (uint256)
createCategoryVoting(bytes32 organ, uint256 x, uint256 y, uint64 category, string categoryName, uint256 duration) returns (uint256)
createDecimalsVoting(bytes32 organ, uint256 x, uint256 y, uint8 decimals, uint256 duration) returns (uint256)
createCategoricalValueVoting(bytes32 organ, uint256 x, uint256 y, uint64 value, address valueAuthor, uint256 duration) returns (uint256)
createNumericalValueVoting(bytes32 organ, uint256 x, uint256 y, uint64 value, address valueAuthor, uint256 duration) returns (uint256)
createThemeVoting(bool isCategorical, uint256 x, string theme, uint256 duration) returns (uint256)
createStatementVoting(bool isCategorical, uint256 x, uint256 y, string statement, uint256 duration) returns (uint256)

// 2. vote — organ comes from the voting, not from the caller
castVote(uint256 votingId, bool support)

// 3. execute — permissionless, strictly after endTime
executeVoting(uint256 votingId) returns (bool)
```

Ids start at `1` (`++nextVotingId`) and `0` is rejected by every guarded entry point. Theme and statement creators take `isCategorical` rather than an organ — they are matrix-axis operations and snapshot `simpleMajority`.

`castVote` took a third `bytes32 organ` argument until 2026-08-24. Anything generated against that form now sends malformed calldata.

`duration` is unvalidated: `endTime = block.timestamp + duration`, no floor or ceiling. Bound it client-side.

### `executeVoting` semantics

Exact behavior from `Votings.sol:416-445`, in order:

| Condition | Result |
| --- | --- |
| still within `[startTime, endTime]` | revert `VotingStillActive` |
| already finalized | revert `VotingAlreadyFinalized` |
| `totalVotes == 0` **or** `totalVotes < quorum` | revert `InsufficientVotes` — **`finalized` stays false, so this is permanent** |
| quorum met | `finalized = true`, emit `VotingFinalized(success)`; mutation applied only if `success` |

`success` is `(forVotes * approvalPercentageBase) / totalVotes > approvalPercentage` — a **strict** `>`, and integer division truncates before the comparison. At the default base of 10 000 the truncation error is 0.01%; at a base of 100 it would be 1%, enough to fail a vote that should pass.

Execution is possible only *strictly after* `endTime`: `isActive` uses `block.timestamp <= endTime`, and execution requires `!isActive`.

The two revert paths never finalize, so such votings remain unfinalized and unexecutable forever. They will keep appearing in any discovery projection. Defect 2.

## Eligibility parameters

```solidity
struct VotingEligibilityParameters {
    uint256 quorum;
    uint256 approvalPercentage;
    uint256 approvalPercentageBase;  // 100 = percent, 10000 = BPS
}
```

Each `Voting` carries its own `eligibilityParameters`, copied at creation from the organ's *resolved* configuration. A later threshold change does **not** alter an existing voting, and the executor must never recompute eligibility from today's configuration.

```solidity
setMinimumQuorum(bytes32 organ, uint256 value)                  // Chairman only — writes .quorum
setMinimumApprovalPercentage(bytes32 organ, uint256 value)      // Chairman only — writes .approvalPercentage
setMinimumApprovalPercentageBase(bytes32 organ, uint256 value)  // Chairman only — writes .approvalPercentageBase
simpleMajority() view returns (uint256, uint256, uint256)       // quorum=1, approval=5000, base=10000 (BPS)
transferChairmanship(address newChairman)                       // Chairman only
```

Resolution goes through a helper rather than reading the mapping directly (`Zarya.sol:496-504`):

```solidity
if (params.approvalPercentageBase == 0) return simpleMajority;
return params;
```

So an unconfigured organ inherits `simpleMajority` and all eight voting types can pass. But the base **doubles as an enable flag**: it returns `simpleMajority` in its entirety, so a quorum or approval set without also setting the base is silently discarded. See "The approval base doubles as an enable flag" in `CONTRACT_DEFECTS.md` before building any configuration UI.

`simpleMajority` is basis points — `5000` of `10000` is 50%. Treat quorum as an exact vote count, not a percentage, and never render an approval figure without dividing by its own base. Preserve the contract's unit; do not normalize to percent.

## Reads

```solidity
// voting
nextVotingId() view returns (uint256)
isVotingActive(uint256 votingId) view returns (bool)
isVotingFinalized(uint256 votingId) view returns (bool)
hasVoted(uint256 votingId, address member) view returns (bool)
getVotingResults(uint256 votingId) view returns (VoteResults)   // { forVotes, againstVotes, totalVotes }

// membership — also the Chairman check, via the Chairperson organ
isMember(bytes32 organ, address member) view returns (bool)

// matrix metadata
getCategoricalCellOrgan(uint256 x, uint256 y) view returns (bytes32)
getNumericalCellOrgan(uint256 x, uint256 y) view returns (bytes32)
getCategoricalCellInfo(uint256 x, uint256 y) view returns (bytes32, uint64[], uint256)
getNumericalCellInfo(uint256 x, uint256 y) view returns (bytes32, uint8, uint256)
getAllowedCategories(uint256 x, uint256 y) view returns (uint64[])
isCategoryAllowed(uint256 x, uint256 y, uint64 category) view returns (bool)
getCategoryName(uint256 x, uint256 y, uint64 category) view returns (string)
getTheme(bool isCategorical, uint256 x) view returns (string)
getStatement(bool isCategorical, uint256 y) view returns (string)   // keyed by y only

// matrix values — Categorical and Numerical variants are symmetric
getCategoricalLatestValue(uint256 x, uint256 y) view returns (DecodedCheckpoint)
getCategoricalValueAt(uint256 x, uint256 y, uint32 index) view returns (DecodedCheckpoint)
getCategoricalValueAtTimestamp(uint256 x, uint256 y, uint32 timestamp) view returns (DecodedCheckpoint)
getCategoricalSampleLength(uint256 x, uint256 y) view returns (uint256)
getCategoricalHistory(uint256 x, uint256 y, uint32 offset, uint256 limit) view returns (uint32[], address[], uint64[])
```

`DecodedCheckpoint` is `{ uint32 timestamp, address author, uint64 value }`. Two traps in the value readers — `get*ValueAtTimestamp` returns the timestamp you queried rather than the checkpoint's, and `get*ValueAt` panics out of bounds. See the quirks list in `CONTRACT_DEFECTS.md`.

`votingId == 0` is now rejected by the `votingExists` guard, so reads on it revert `VotingNotFound` rather than returning zero-values.

`initializeOrgans(bytes32[] organs, address[] members)` is Chairman-only, one-shot, and reverts `OrgansAlreadyInitialized` after the first call. It seeds the initial membership; after that, members are added and revoked by membership voting.

## Not exposed

Design around these absences rather than inventing a read API.

| Missing | Consequence |
| --- | --- |
| Per-organ eligibility getter | `_votingEligibilityParametersByOrgan` is `internal`. UI **cannot** show an organ's configured thresholds, nor read back whether a configuration write took effect. Only `simpleMajority()` is readable. |
| Per-voting eligibility snapshot | `getVotingResults` returns vote counts only. UI **cannot** show the thresholds a given voting will be judged against. |
| A voting's `governingOrgan` | The field exists on the struct but nothing exposes it, and `castVote` now depends on it. Recover it from the creation events, which carry `organ` — this makes the event projection load-bearing for vote preflight. |
| Voting struct getter | No `getVoting(id)`. `endTime` comes from the `VotingCreated` event, not a read. Discovery must index events. |
| Matrix dimensions or cell enumeration | Every matrix read is `(x, y)`-addressed. Nothing reports the matrix size or which cells exist, so the contract **cannot be asked what the matrix contains**. Project coordinates from events — see below. |
| `bytes32` → organ label | `getPartyOrganIdentifier` takes the triple, while every cell getter returns `bytes32`. Displaying an organ beside a cell needs a locally built reverse index keyed by `bytes32`. Both helpers are `pure`, so cache it permanently. |

`getChairman()` is also absent, but no longer a limitation — see "Chairman identity is readable" above.

## Symbols the ABI does not carry

`Matricies.addValue`, `Matricies.setDecimals`, `setTheme`, and `setStatement` are **`external`** library functions, so they are deployed as a linked library and called by `DELEGATECALL`. Solidity does not fold an externally-linked library's events and errors into the calling contract's ABI. `Matricies.addCategory` is `internal` and therefore inlined, which is why its event and errors *are* present.

Confirmed from the deployed artifact, not inferred: `contracts/Zarya.json`'s `metadata.settings.libraries` names the address `Matricies` was linked at. `DEPLOYMENT.md` records all four.

The practical consequences:

```solidity
event ValueAdded(uint256 indexed x, uint256 indexed y, uint64 value, address indexed author)  // Matricies.sol:45
error NoThemeSet(bool isCategorical, uint256 x)
error NoStatementSet(bool isCategorical, uint256 y)
error InvalidCategory(uint64 category)
```

- **`ValueAdded` exists and does fire.** Earlier notes recorded it as absent because it is not in the ABI. Because the library call is a `DELEGATECALL`, the log is emitted at the **Zarya address** and is subscribable — the client just needs a hand-written ABI fragment for it. It carries `x` and `y` indexed, so it is a direct coordinate source.
  `ValueAdded` does **not** carry `isCategorical`, so it cannot say which of the two matrices changed. Disambiguate by reading `getCategoricalCellOrgan` / `getNumericalCellOrgan` at those coordinates — a non-zero organ identifies the matrix.
- **Three errors will arrive as undecodable selectors** unless registered manually. Add them to the error registry alongside `Panic(0x11)`, `Panic(0x12)`, and `Panic(0x32)`, which the ABI also does not describe.

`setTheme` and `setStatement` emit nothing at all, so theme and statement changes are observable only through their creation events plus finalization.

## Events

```solidity
VotingCreated(uint256 indexed votingId, address indexed author, uint256 startTime, uint256 endTime, uint8 suggestionType)
VotingFinalized(uint256 indexed votingId, bool success, uint256 forVotes, uint256 againstVotes)
VoteCasted(uint256 indexed votingId, address indexed partyMember, bool support, uint256 forVotes, uint256 againstVotes)
CategoryAdded(uint256 indexed x, uint256 indexed y, uint64 category)

// per-type creation detail, all with indexed votingId
MembershipVotingCreated / MembershipRevocationVotingCreated / CategoryVotingCreated /
DecimalsVotingCreated / ThemeVotingCreated / StatementVotingCreated /
CategoricalValueVotingCreated / NumericalValueVotingCreated
```

`VotingCreated` is the discovery primitive: indexed by `votingId` and the only carrier of `endTime`. Index it with a persisted block cursor and reconcile against `isVotingFinalized`. `nextVotingId()` supports bounded paging as a fallback. Do not rescan the chain on every poll.

`SuggestionType` is `{ Membership, MembershipRevocation, Category, Decimals, Theme, Statement, CategoricalValue, NumericalValue }` — ordinals 0-7, in that order.

### Enumerating the matrix

Matrix state changes only through a successful voting, so a projection over the event stream is a **complete** coordinate index. Two routes, and the right answer uses both:

**Applied changes** — `ValueAdded` and `CategoryAdded` fire only on application, so they need no gating:

```solidity
ValueAdded(x indexed, y indexed, value, author indexed)   // not in the ABI; see above
CategoryAdded(x indexed, y indexed, category)
```

**Everything else** — decimals, themes, statements emit no application event, so project their creation events gated on `VotingFinalized(success = true)` for the same `votingId`:

```solidity
DecimalsVotingCreated(votingId, organ, x, y, decimals)
ThemeVotingCreated(votingId, isCategorical, x, theme)
StatementVotingCreated(votingId, isCategorical, x, y, statement)
```

The theme and statement events carry the label text itself, so the axis inventory needs no chain read — though `getTheme` / `getStatement` should confirm it, since a later voting at the same coordinate overwrites.

This is the **same cursor** the executor already maintains. The matrix index is a second projection over it, never an independent sweep.

All eight voting types can now pass, so expect this projection to find populated cells as well as axes. Until the contract fixes landed, only themes and statements were reachable — a matrix populated before then will show that history.

## Custom errors

The ABI's 16, plus the four the library split hides and the panics. Decode them all; do not invent generic categories.

| Error | Domain meaning |
| --- | --- |
| `AlreadyVoted(address)` | Idempotent already-completed, not a failure |
| `NotActiveMember(bytes32,address)` | Caller is not a member of the organ they named — also the failure mode of a member-or-Chairman check |
| `NotChairman(address)` | Privileged configuration denied |
| `VotingNotFound(uint256)` | Id of `0`, id above `nextVotingId`, or wrong contract |
| `VotingNotActive(uint256)` | Voting window closed — do not cast |
| `VotingStillActive(uint256)` | `executeVoting` at or before `endTime` |
| `VotingAlreadyFinalized(uint256)` | Another client won the race; treat as completed |
| `InsufficientVotes(uint256,uint256)` | Zero votes, or quorum not met. **Terminal — the voting never finalizes and never becomes executable** |
| `InvalidOrgan(bytes32)` | Cell already bound to a different organ. Also what a wrong region ordinal produces if the cell is bound |
| `InvalidPartyOrganType(uint8)` | Organ type above 7 |
| `UnknownRegion(uint8)` | Region ordinal above 97 |
| `CannotRemoveChairman(bytes32,address)` | Checked at creation only, not at execution |
| `InvalidMemberAddress()` | Zero address in constructor, `initializeOrgans`, or `transferChairmanship` |
| `CategoryAlreadyExists(uint64)` | Duplicate category on a cell |
| `OrgansAlreadyInitialized()` | Setup already done — permanent |
| `EmptyInitializationData()` | Empty or length-mismatched setup input |
| `NoThemeSet(bool,uint256)` | **Not in the ABI.** No theme at `x` when adding a value or statement |
| `NoStatementSet(bool,uint256)` | **Not in the ABI.** No statement at `y` when adding a value |
| `InvalidCategory(uint64)` | **Not in the ABI.** Category not allowed on that cell, or cell organ mismatch |
| `Panic(0x32)` | Array index out of bounds in `get*ValueAt` |

`Panic(0x12)` from `executeVoting` is no longer reachable — the zero-vote division was guarded on 2026-08-24. Keep decoding it anyway; the deployed contract may predate the fix.

## Invariants worth testing

1. A voting snapshots eligibility at creation; a later Chairman change does not rewrite it.
2. An unconfigured organ resolves to `simpleMajority`; a fully configured one to its own values.
3. **A quorum set without a base is ignored** — the organ still uses `simpleMajority`. Setting the base afterwards activates the previously written quorum.
4. Chairman-only setters reject ordinary members; the four matrix-configuration votings reject the Chairman when not a member.
5. One address cannot vote twice in one voting.
6. Execution cannot be repeated, and a quorum-failed voting cannot be executed at all — ever.
7. `executeVoting` has no caller-supplied policy arguments.
8. Exact approval boundary: at, one above, one below, in basis points.
9. Zero votes reverts `InsufficientVotes` at any quorum, including zero.
10. Matrix state changes only through a successful voting path; cell organ binding is permanent.
11. Chairman removal protection and `transferChairmanship` restriction hold.
12. A region's enum ordinal and its subject code resolve to different organs wherever the two numbers differ.
13. `castVote` rejects a non-member of the voting's own organ, and accepts anyone on a theme or statement voting.
