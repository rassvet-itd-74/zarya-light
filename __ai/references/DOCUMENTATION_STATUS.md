# Documentation status

Where `temporal_docs/` prose and the contract disagree. Exists to stop agents from silently merging contradictory documentation into invented contract behavior.

**Sources:** `temporal_docs/Zarya.sol` plus `temporal_docs/libraries/{Votings,PartyOrgans,Matricies,Regions}.sol` (authoritative), `src/chain/abi/Zarya.abi.json` (agrees with the source on the external surface), `temporal_docs/README.md`, `temporal_docs/whitepaper.md` (prose, partly stale).

**All previously open questions are closed.** The Solidity source arrived on 2026-08-24 and answered every one. Several answers were the unfavorable branch; those are recorded in `CONTRACT_DEFECTS.md` rather than here. There is still no test suite, so behavior is read from source rather than proven by execution, and the deployed bytecode remains the final authority.

## Prose checked against source

| Prose | Verdict |
| --- | --- |
| `whitepaper.md:531` — `executeVoting(votingId, minimumQuorum, minimumApprovalPercentage)` | **Stale.** `whitepaper.md:753`, `README.md:128`, the ABI, and `Zarya.sol:279` all agree on the one-argument form |
| `whitepaper.md:454` — "только члены соответствующего органа" | **Wrong for the Chairman**, who falls back to Chairperson membership. Correct for ordinary members as of 2026-08-24, when the vote became scoped to the voting's own organ |
| `README.md:120` — Chairman may vote across organs | Correct |
| `README.md:152` — an organ with no configured quorum accepts any number of participants | Correct, including zero. That path used to divide by zero (`Panic(0x12)`); guarded on 2026-08-24 to revert `InsufficientVotes`, which still never finalizes |
| `whitepaper.md:425`, `447` — eligibility snapshotted at creation | Correct, matches `Votings.sol` exactly |
| `whitepaper.md:762` — approval is a strict `>` | Correct, matches `Votings.sol:430`. Integer division truncates before the comparison |
| `whitepaper.md:555` — `ValueAdded` fires | Correct. Earlier notes in this repository recorded it as nonexistent because it is absent from the ABI; **that inference was wrong**, and a listener should be written. See "Symbols the ABI does not carry" in `CONTRACT.md` |
| `whitepaper.md:467` — region enum annotation | Accurate as documentation of subject codes, actively misleading as documentation of argument values. The ABI takes the **ordinal**; the two differ for 50 of 98 regions |

## Prose that remains misleading

Not contradictions of a specific line so much as an overall impression the documentation gives that the code does not support. A reader who trusts the prose will design the wrong client.

- **The Chairman is described as a universal participant.** True for `castVote` and membership votings; false for the four matrix-configuration votings, where the Chairman needs actual membership.
- **`castVote` is documented with an organ argument.** It no longer takes one. Any prose or example showing three arguments is stale as of 2026-08-24.
- **Thresholds read as three independent settings.** They are not: an organ whose base is zero ignores the other two entirely.
- **Percentage figures in the prose are percentages, not parameters.** The contract works in basis points, so "51%" is `5100`, not `51`.

## Document format — specified by us, not by `temporal_docs`

`temporal_docs/` says nothing about document intake. It does not need to: governance documents are **PDF AcroForms that this app issues**, so the app owns the schema rather than reverse-engineering someone else's.

The field-name schema lives in `.claude/skills/zarya-pdf-forms/SKILL.md` and is versioned by `zarya.meta.schemaVersion`. Changing it is a product decision recorded there, not a documentation mismatch to resolve here. This does not make returned forms trustworthy — see "Form trust boundary" in `INVARIANTS.md`.
