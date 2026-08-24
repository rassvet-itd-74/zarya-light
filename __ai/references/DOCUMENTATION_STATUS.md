# Documentation status

Tracks where `temporal_docs/` prose and the contract disagree. Exists to stop agents from silently merging contradictory documentation into invented contract behavior.

**Sources:** `temporal_docs/Zarya.sol` plus `temporal_docs/libraries/{Votings,PartyOrgans,Matricies,Regions}.sol` (authoritative), `src/chain/abi/Zarya.abi.json` (agrees with the source on the external surface), `temporal_docs/README.md`, `temporal_docs/whitepaper.md` (prose, partly stale).

**All previously open questions are now closed.** The Solidity source arrived on 2026-08-24 and answered every one of them. Several answers were the unfavorable branch, and those are recorded as defects in `CONTRACT_DEFECTS.md` rather than here — this file is only for prose that contradicts the code.

There is still no test suite in the repository, so behavior is read from source rather than proven by execution. The deployed bytecode remains the final authority; where a claim is cheap to confirm against Sepolia, `CONTRACT_DEFECTS.md` names the confirmation.

## Resolved by source

### 1. Rejection semantics — both, depending on which check fails

Previously the highest-severity open question, and the answer is split (`Votings.sol:417-440`):

- **Quorum failure reverts** `InsufficientVotes` and leaves `finalized == false`. The voting is permanently unexecutable and will keep reappearing in discovery.
- **Approval failure finalizes** with `success = false`, emits `VotingFinalized`, and is terminal in the ordinary way.

So `FINALIZED_REJECTED` is reachable, but only through the approval path. The dangerous reading was also correct — for the other path. Retry design must distinguish them. Defect 2.

### 2. Chairman cross-organ `castVote` — permitted

`README.md:120` was right and `whitepaper.md:454`'s "только члены соответствующего органа" is wrong for the Chairman specifically. `castVote` resolves to `_onlyMemberOrChairman`, which falls back to Chairperson membership.

For ordinary members the whitepaper is now correct: as of 2026-08-24 the vote is scoped to the voting's own organ, read from stored state. Before that fix any member of any organ could vote on anything.

### 3. Zero-vote execution — was a panic, now a clean revert

`README.md:152` is right that an organ with no configured quorum accepts any number of participants — including zero, which the old quorum guard waved through into a division by `totalVotes == 0`, raising `Panic(0x12)`.

Guarded as of 2026-08-24: `totalVotes == 0` now reverts `InsufficientVotes`. The voting still never finalizes, so it remains permanently unexecutable — see "Quorum failure is permanent" in `CONTRACT_DEFECTS.md`.

### 4. Region enum value versus subject code — the ordinal, and the trap is worse than expected

`Regions.sol` declares 98 members with subject codes in trailing comments, and `Regions.toString` maps ordinal → code for display. The ABI takes the **ordinal**. The two numbers differ for 50 of 98 regions, and passing a code instead of an ordinal usually addresses a different real region rather than reverting.

`CHELYABINSKAYA_OBLAST` is ordinal 74 *and* code "74", so the project's own region works either way and masks the bug in testing. Defect 3.

### 5. `ValueAdded` — exists and fires; it is only missing from the ABI

`whitepaper.md:555` is correct. The event is declared at `Matricies.sol:45` and emitted by `addValue`. Earlier notes in this repository recorded it as nonexistent because it is absent from the ABI — **that inference was wrong.**

`addValue` is an `external` library function, so `Matricies` is deployed separately and Solidity does not fold its events into Zarya's ABI. The call is a `DELEGATECALL`, so the log is still emitted at the Zarya address and is subscribable with a hand-written fragment. The same mechanism hides three errors. See "Symbols the ABI does not carry" in `CONTRACT.md`.

Do write a listener for it. The earlier instruction not to was based on the faulty inference.

### 6. `executeVoting` takes one argument

`whitepaper.md:531` still lists `executeVoting(votingId, minimumQuorum, minimumApprovalPercentage)`. **That line is stale.** `whitepaper.md:753`, `README.md:128`, the ABI, and `Zarya.sol:279` all agree on the one-argument form.

### 7. Eligibility is snapshotted at creation

`whitepaper.md:425` and `447` match `Votings.sol` exactly: every `create*Voting` copies the organ's three parameters into `Voting.eligibilityParameters` at creation. A later Chairman change does not reach an existing voting.

### 8. The approval formula is a strict `>`

`whitepaper.md:762` matches `Votings.sol:430`. Integer division truncates before the comparison, so an organ configured at `50` passes on 51% and one at `51` needs 52%. Do not normalize the operator in either direction from prose.

Since 2026-08-24 the base is `10 000` rather than `100`, so the boundary is expressed in basis points — an organ configured at `5000` passes on 50.01%. The prose's talk of a "51%" threshold is a percentage figure, not a parameter value; do not write `51` into the contract.

## Prose that remains misleading

Not contradictions of a specific line so much as an overall impression the documentation gives that the code does not support. Worth naming, because a reader who trusts the prose will design the wrong client.

- **The Chairman is described as a universal participant.** True for `castVote` and membership votings; false for the four matrix-configuration votings, where the Chairman needs actual membership.
- **`castVote` is documented with an organ argument.** It no longer takes one — the organ comes from the voting. Any prose or example showing three arguments is stale as of 2026-08-24.
- **Thresholds read as three independent settings.** They are not: an organ whose base is zero ignores the other two entirely.
- **Percentage figures in the prose are percentages, not parameters.** The contract works in basis points, so "51%" is `5100`, not `51`.
- **`whitepaper.md:467`'s enum annotation** is accurate as documentation of subject codes and actively misleading as documentation of argument values.

## Document format — specified by us, not by `temporal_docs`

`temporal_docs/` says nothing about document intake. It does not need to: governance documents are **PDF AcroForms that this app issues**, so the app owns the schema rather than reverse-engineering someone else's.

The field-name schema lives in `.claude/skills/zarya-pdf-forms/SKILL.md` and is versioned by `zarya.meta.schemaVersion`. Changing it is a product decision recorded there, not a documentation mismatch to resolve here.

This does not make returned forms trustworthy — see the trust rule in `INVARIANTS.md` under "Form trust boundary".
