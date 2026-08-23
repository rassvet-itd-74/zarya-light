# Zarya contract surface

**Derived from `src/chain/abi/Zarya.abi.json`** — 1 constructor, 42 functions, 12 events, 16 custom errors. This file records what the ABI says; the ABI wins if they ever disagree. For known-stale documentation lines and the questions an ABI cannot answer, see `DOCUMENTATION_STATUS.md`. For network and address, see `DEPLOYMENT.md`.

## Organ encoding

An organ is a **`bytes32`**, not a string. It is derived from a triple:

```solidity
getPartyOrgan(uint8 organType, uint8 region, uint256 number) pure returns (bytes32)
getPartyOrganIdentifier(uint8 organType, uint8 region, uint256 number) pure returns (string)
```

Both are `pure`, so they can be called without state. Use `getPartyOrgan` to obtain the `bytes32` for a call and `getPartyOrganIdentifier` for display.

**Do not hash a Cyrillic identifier string yourself.** The intent model must carry the structured triple, not the label.

| Organ | Code | `PartyOrganType` |
| --- | --- | --- |
| Party congress | `СЗД` | `Congress` |
| Chairman | `ПРЛ` | `Chairperson` |
| Central soviet | `СОВ` | `CentralSoviet` |
| Regional conference | `НН.КОН` | `RegionalConference` |
| Regional general assembly | `НН.ОБС` | `RegionalGeneralAssembly` |
| Regional soviet | `НН.СОВ` | `RegionalSoviet` |
| Local general assembly | `НН.Х.ОБС` | `LocalGeneralAssembly` |
| Local soviet | `НН.Х.СОВ` | `LocalSoviet` |

Identifier grammar is `[NN.[X.]]TYPE`: federal organs carry the bare suffix, regional organs a region prefix, local organs a region and number prefix.

> `region` is a `Region` enum value. The whitepaper annotates entries with their subject codes (`CHELYABINSKAYA_OBLAST // = 74`), but Solidity enums are sequential from zero, so the enum value and the subject code are probably **not** the same number. Passing the wrong one yields a valid-looking but wrong `bytes32`. Unresolved — see `DOCUMENTATION_STATUS.md`.

## Voting lifecycle

```solidity
// 1. create — caller must be a member of the organ
createMembershipVoting(bytes32 organ, address member, uint256 duration) returns (uint256)
createMembershipRevocationVoting(bytes32 organ, address member, uint256 duration) returns (uint256)
createCategoryVoting(bytes32 organ, uint256 x, uint256 y, uint64 category, string categoryName, uint256 duration) returns (uint256)
createDecimalsVoting(bytes32 organ, uint256 x, uint256 y, uint8 decimals, uint256 duration) returns (uint256)
createCategoricalValueVoting(bytes32 organ, uint256 x, uint256 y, uint64 value, address valueAuthor, uint256 duration) returns (uint256)
createNumericalValueVoting(bytes32 organ, uint256 x, uint256 y, uint64 value, address valueAuthor, uint256 duration) returns (uint256)
createThemeVoting(bool isCategorical, uint256 x, string theme, uint256 duration) returns (uint256)
createStatementVoting(bool isCategorical, uint256 x, uint256 y, string statement, uint256 duration) returns (uint256)

// 2. vote
castVote(uint256 votingId, bool support, bytes32 organ)

// 3. execute — permissionless, after endTime
executeVoting(uint256 votingId) returns (bool)
```

Note that theme and statement creators take `isCategorical` rather than an organ — they are matrix-axis operations, and per the docs they use the `simpleMajority` policy.

`executeVoting` takes **one argument**. It returns `bool`. The three-argument form that appears in one whitepaper paragraph does not exist in the ABI.

Documented execution checks:
1. `block.timestamp >= endTime`
2. not already finalized
3. `totalVotes >= eligibilityParameters.quorum`
4. `(forVotes * eligibilityParameters.approvalPercentageBase) / totalVotes > eligibilityParameters.approvalPercentage` — a **strict** `>`

## Eligibility parameters

```solidity
struct VotingEligibilityParameters {
    uint256 quorum;
    uint256 approvalPercentage;
    uint256 approvalPercentageBase;  // 100 = percent, 10000 = BPS
}
```

Each `Voting` carries its own `eligibilityParameters`, copied at creation from the organ's configuration. A later threshold change does **not** retroactively alter an existing voting, and the executor must never recompute eligibility from today's organ configuration.

```solidity
setMinimumQuorum(bytes32 organ, uint256 value)              // Chairman only
setMinimumApprovalPercentage(bytes32 organ, uint256 value)  // Chairman only
simpleMajority() view returns (uint256, uint256, uint256)   // quorum=1, approval=50, base=100
transferChairmanship(address newChairman)                   // current Chairman only
```

Treat quorum as an exact vote count, not a percentage. Preserve the contract's approval unit and base; do not reinterpret `51`.

## Reads

```solidity
// voting
nextVotingId() view returns (uint256)
isVotingActive(uint256 votingId) view returns (bool)
isVotingFinalized(uint256 votingId) view returns (bool)
hasVoted(uint256 votingId, address member) view returns (bool)
getVotingResults(uint256 votingId) view returns (VoteResults)   // { forVotes, againstVotes, totalVotes }

// membership
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
getStatement(bool isCategorical, uint256 y) view returns (string)

// matrix values — Categorical and Numerical variants are symmetric
getCategoricalLatestValue(uint256 x, uint256 y) view returns (DecodedCheckpoint)
getCategoricalValueAt(uint256 x, uint256 y, uint32 index) view returns (DecodedCheckpoint)
getCategoricalValueAtTimestamp(uint256 x, uint256 y, uint32 timestamp) view returns (DecodedCheckpoint)
getCategoricalSampleLength(uint256 x, uint256 y) view returns (uint256)
getCategoricalHistory(uint256 x, uint256 y, uint32 offset, uint256 limit) view returns (uint32[], address[], uint64[])
```

`DecodedCheckpoint` is `{ uint32 timestamp, address author, uint64 value }`.

`initializeOrgans(bytes32[] organs, address[] members)` is one-time setup; it reverts with `OrgansAlreadyInitialized`.

## Not exposed

Design around these absences rather than inventing a read API:

| Missing | Consequence |
| --- | --- |
| Per-organ eligibility getter | `_votingEligibilityParametersByOrgan` is `internal`. UI **cannot** show an organ's configured thresholds. Only `simpleMajority()` is readable. |
| Per-voting eligibility snapshot | `getVotingResults` returns vote counts only. UI **cannot** show the thresholds a given voting will be judged against. |
| `getChairman()` | Chairman identity comes from configuration, not chain. Chairman-only preflight must **simulate the call and catch `NotChairman`**, not check identity first. |
| `ValueAdded` event | The whitepaper promises one; the ABI has none. Derive matrix changes from `VotingFinalized(success=true)` plus `suggestionType`, or poll the latest-value getters. |
| Voting struct getter | No `getVoting(id)`. `endTime` is available from the `VotingCreated` event, not a read. Discovery must index events. |

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

`VotingCreated` is the discovery primitive: it is indexed by `votingId` and carries `endTime`, which is available nowhere else. Index it with a persisted block cursor and reconcile against `isVotingFinalized`. `nextVotingId()` supports bounded paging as a fallback. Do not rescan the chain on every poll.

## Custom errors

These 16 are the real classification taxonomy. Decode them; do not invent generic categories.

| Error | Domain meaning |
| --- | --- |
| `AlreadyVoted(address)` | Idempotent already-completed, not a failure |
| `NotActiveMember(bytes32,address)` | Signer not a member of that organ |
| `NotChairman(address)` | Privileged configuration denied |
| `VotingNotFound(uint256)` | Bad id or wrong contract |
| `VotingNotActive(uint256)` | Voting window closed — do not cast |
| `VotingStillActive(uint256)` | `executeVoting` before `endTime` |
| `VotingAlreadyFinalized(uint256)` | Another client won the race; treat as completed |
| `InsufficientVotes(uint256,uint256)` | Quorum or approval not met — **see `DOCUMENTATION_STATUS.md`, this may mean the voting never finalizes** |
| `InvalidOrgan(bytes32)` | Organ encoding wrong — suspect the region-enum trap |
| `InvalidPartyOrganType(uint8)` | Bad organ type |
| `UnknownRegion(uint8)` | Bad region enum value |
| `CannotRemoveChairman(bytes32,address)` | Chairman removal protection |
| `InvalidMemberAddress()` | Address validation |
| `CategoryAlreadyExists(uint64)` | Duplicate category |
| `OrgansAlreadyInitialized()` | Setup already done |
| `EmptyInitializationData()` | Setup input empty |

## Invariants worth testing

1. A voting snapshots eligibility at creation; a later Chairman change does not rewrite it.
2. Theme and statement votings receive the `simpleMajority` snapshot.
3. Chairman-only setters reject ordinary members.
4. One address cannot vote twice in one voting.
5. Execution cannot be repeated.
6. `executeVoting` has no caller-supplied policy arguments.
7. Exact approval boundary: at, one above, one below.
8. Zero-vote behavior — the formula divides by `totalVotes`.
9. Matrix state changes only through a successful voting path; cell organ ownership is enforced.
10. Chairman removal protection and `transferChairmanship` restriction hold.
