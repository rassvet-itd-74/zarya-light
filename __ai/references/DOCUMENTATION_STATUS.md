# Documentation status

Tracks where `temporal_docs/` and the ABI disagree, and which questions remain genuinely open. Exists to stop agents from silently merging contradictory prose into invented contract behavior.

**Sources:** `src/chain/abi/Zarya.abi.json` (authoritative on the contract surface), `temporal_docs/README.md`, `temporal_docs/whitepaper.md`. No Solidity source or test suite is present in this repository.

## What an ABI can and cannot settle

An ABI proves which functions, events, and errors exist and their exact types. It says **nothing** about authorization logic, comparison operators, or whether a failed check reverts or records a result. Those need source, tests, or a live read.

Everything under "Resolved" is settled by types. Everything under "Open" needs one of the other three.

## Resolved

### `executeVoting` takes one argument

```solidity
executeVoting(uint256 votingId) returns (bool)
```

`temporal_docs/whitepaper.md:531` still lists `executeVoting(votingId, minimumQuorum, minimumApprovalPercentage)`. **That line is stale.** `whitepaper.md:753` and `README.md:128` both use the one-argument form, and the ABI confirms it.

The executor supplies no policy. Eligibility comes from the voting's own snapshot.

### Eligibility is snapshotted at creation

`whitepaper.md:425` — values are fixed at creation from `_votingEligibilityParametersByOrgan[organ]`; `whitepaper.md:447` — `Voting.eligibilityParameters`. Consistent with the ABI: `simpleMajority` is `public` and appears as a getter, while the per-organ mapping is `internal` and correctly has none.

### Chairman-only threshold setters exist

`setMinimumQuorum(bytes32,uint256)` and `setMinimumApprovalPercentage(bytes32,uint256)` are both present, and `NotChairman(address)` exists to enforce them.

### The approval formula is a strict `>`

`whitepaper.md:762`:

```text
(forVotes * approvalPercentageBase) / totalVotes > approvalPercentage
```

Earlier notes flagged a conflict with prose describing a "minimum threshold" of 51%, which would imply `>=`. The formula is unambiguous. This is no longer a contradiction — but the boundary still needs a test, because a strict `>` means an organ configured at `50` passes on 51% and an organ at `51` needs 52%. Do not normalize the operator either direction from prose.

## Open

### 1. Rejection semantics — does a failed voting finalize, or revert?

**The most consequential open question, and previously mis-stated as settled.**

The ABI supports both readings:
- `InsufficientVotes(uint256,uint256)` is a **custom error**, implying `executeVoting` *reverts* when quorum or approval is not met — in which case the voting is never finalized and stays executable forever.
- `executeVoting` returns `bool`, and `VotingFinalized(votingId, bool success, ...)` carries a success flag — implying it *finalizes* with `success = false`.

`whitepaper.md:758-763` calls items 3 and 4 "проверки" (checks), which in Solidity usually means reverts. It does not say what happens on failure.

**Why this matters:** if a failed vote reverts, the executor sees a revert on a voting that will never succeed, and any retry policy will retry it forever while reporting a political outcome as a technical error. If it finalizes with `success = false`, the state machine's terminal `FINALIZED_REJECTED` is correct.

`STATE_MACHINES.md` previously asserted the second reading as fact with no evidence. It now points here.

**Closed by:** the `executeVoting` body in Solidity, or a Sepolia call against a voting known to have failed quorum.

**Until then:** do not implement a retry policy that assumes a revert is transient. Treat `InsufficientVotes` as terminal-pending-verification and surface it distinctly from RPC failure.

### 2. Chairman cross-organ `castVote`

`temporal_docs/README.md:120` is explicit: the Chairman (`ПРЛ`) may participate in voting of **any** organ. But `whitepaper.md:454` describes `castVote` as "только члены соответствующего органа" (members of the relevant organ only) and does not restate the exception.

The ABI cannot resolve this — authorization lives in the function body. `NotActiveMember(bytes32,address)` proves a membership check exists; it does not reveal whether a Chairman branch bypasses it.

**Closed by:** the `castVote` authorization path in Solidity, or a live Sepolia call from the Chairman address against an organ it does not belong to.

**Until then:** client preflight must **not** reject a Chairman cross-organ vote. Simulate the call and let the contract decide. Equally, do not assume the override exists.

### 3. Zero-vote execution

`README.md:152` — if no quorum is configured for an organ, a voting passes with any number of participants. But the approval formula divides by `totalVotes`, so `totalVotes == 0` is a division by zero.

Either the contract guards it, or `executeVoting` panics on an unvoted expired voting. An executor that discovers expired votings will eventually hit exactly this case.

**Closed by:** the `executeVoting` body, or a Sepolia call against an expired voting with zero votes.

### 4. Region enum value versus subject code

`whitepaper.md:467` annotates the enum with subject codes:

```solidity
enum Region { FEDERAL, CHELYABINSKAYA_OBLAST, MOSCOW_77, DONETSK_PEOPLES_REPUBLIC, ... }
//            = 00      = 74                   = 77        = 80
```

Solidity enums are sequential from zero, so `CHELYABINSKAYA_OBLAST` is almost certainly `1`, not `74`. `getPartyOrgan(organType, region, number)` takes `uint8 region` — passing `74` where `1` is meant produces a different, valid-looking `bytes32`, and every call using it fails with `InvalidOrgan` or, worse, silently addresses the wrong organ.

**Closed by:** the `Regions.sol` enum declaration, or comparing `getPartyOrganIdentifier(organType, candidate, number)` output against the expected label — the identifier getter is `pure`, so this is a free read and the cheapest way to settle it.

**Do this first** in any organ-resolution work. Every organ-addressed call depends on it.

### 5. `ValueAdded` event does not exist

`whitepaper.md:555` states that a `ValueAdded` event is emitted for off-chain indexing after a value voting executes. **The ABI has no such event.** The 12 events are the creation events, `VoteCasted`, `VotingCreated`, `VotingFinalized`, and `CategoryAdded`.

Off-chain indexing of matrix values must derive changes from `VotingFinalized(success=true)` plus the voting's `suggestionType`, or poll `getCategoricalLatestValue` / `getNumericalLatestValue`. Do not write a listener for an event that will never fire.

## Document format — specified by us, not by `temporal_docs`

`temporal_docs/` says nothing about document intake. It does not need to: governance documents are **PDF AcroForms that this app issues**, so the app owns the schema rather than reverse-engineering someone else's.

The field-name schema lives in `.claude/skills/zarya-pdf-forms/SKILL.md` and is versioned by `zarya.meta.schemaVersion`. Changing it is a product decision recorded there, not a documentation mismatch to resolve here.

This closes what was previously the largest gap in this file. It does not make returned forms trustworthy — see the trust rule in `INVARIANTS.md` under "Form trust boundary".
