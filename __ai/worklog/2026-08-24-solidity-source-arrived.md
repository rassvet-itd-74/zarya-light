# Reconcile the AI package against the Solidity source

## Ask

The actual Zarya contract sources were added to `temporal_docs/`. Use them to alter the AI docs and skills where applicable.

## Changes

`temporal_docs/Zarya.sol` plus `libraries/{Votings,PartyOrgans,Matricies,Regions}.sol` arrived. Before changing anything I checked that they describe the deployed contract: the source's external/public surface plus its two public state variables matches the ABI's 42 functions exactly, with no symbol on either side unaccounted for. `contracts/Zarya.json`'s `metadata.sources` independently lists `src/Zarya.sol` and the same four libraries. So the source is authoritative for this artifact, and the precedence order changed accordingly — source, then ABI, then prose — in `CLAUDE.md`, `ROUTER.md`, and `DECISIONS.md`.

**All five open questions closed.** Four of the five answers were the unfavourable branch, and two of those were recorded backwards in the package:

- **Rejection semantics** split rather than resolving one way. Quorum failure reverts `InsufficientVotes` without setting `finalized`, so the voting is unexecutable forever and keeps reappearing in discovery. Approval failure finalizes cleanly with `success = false`. The old "terminal-pending-verification" hedge became two distinct states.
- **Chairman cross-organ `castVote`** is permitted, and the real finding is broader: `castVote`'s `organ` argument is never compared against the voting's own organ, so any member of any organ can vote on any voting. The argument is a membership proof, not a scope check.
- **Zero-vote execution** is unguarded. A zero quorum passes the quorum check with zero votes and then divides by zero — `Panic(0x12)`, not a custom error, and also permanent.
- **Region encoding** is the enum ordinal. The subject code differs for 50 of 98 regions and passing one silently addresses a *different real region*; only 2 of 98 are out of bounds and would revert. Chelyabinsk is ordinal 74 *and* code "74", so the project's own region works either way and hides the bug in any test written against it.
- **`ValueAdded` exists and fires.** The package recorded it as nonexistent because it is absent from the ABI. That inference was wrong: `addValue` is an `external` library function, so `Matricies` is linked separately and Solidity leaves its events out of the calling contract's ABI. The `DELEGATECALL` means the log still lands at the Zarya address, so it is subscribable with a hand-written fragment. The same mechanism hides three errors — `NoThemeSet`, `NoStatementSet`, `InvalidCategory` — which will otherwise arrive as undecodable selectors.

**One defect outranks all of the above.** `approvalPercentageBase` is read at eight sites and written at none: `setMinimumQuorum` writes `.quorum`, `setMinimumApprovalPercentage` writes `.approvalPercentage`, and nothing writes the base. It is therefore `0` for every organ, permanently, which makes the approval numerator zero and `success` unreachable for all six organ-parameterized voting types. Only theme and statement votings — which snapshot the inline-initialized `simpleMajority` — can pass. So the member set is frozen after the single `initializeOrgans` call, and the matrix can never hold a value, category, decimals, or cell organ.

That is a product blocker rather than a client bug, and it reaches into most of the package: the matrix report will show axis labels and no cells (correct output, now documented as such), executor health must not read a permanent rejection rate as degradation, and `setMinimumApprovalPercentage` is inert while remaining a legitimate call.

New `__ai/references/CONTRACT_DEFECTS.md` holds seven defects with evidence, client-side consequence, and what a contract-side fix would be, plus eight smaller quirks. It is a separate file from `DOCUMENTATION_STATUS.md` because these are not prose mismatches — the documentation never anticipated them — and separate from `CONTRACT.md` because that file describes the surface rather than what to do about it.

`CONTRACT.md` was rewritten against source: an access-control table (which exposed that theme and statement creation is permissionless, and that the Chairman is *not* exempt on the four matrix-configuration votings), exact `executeVoting` branch semantics, the three organ types that ignore region and number, the library-hidden symbols, and a corrected "not exposed" table — `getChairman()` is absent but Chairman identity is readable via `isMember` against the Chairperson organ, which retires a gotcha that had been in `CLAUDE.md` since the first slice.

`DOCUMENTATION_STATUS.md` inverted: everything moved to resolved, and it gained a section on prose that is not individually wrong but leaves a reader with an impression the code does not support.

Updated to match: `CLAUDE.md` gotchas, `STATE_MACHINES.md` (new terminal `UNEXECUTABLE` state), `DECISIONS.md`, `DEPLOYMENT.md` (library addresses, Chairman identity), `IMPLEMENTATION_ORDER.md` (Phase 0 closed; the residue is now a product decision about defect 1, with a recommendation), `USE_CASES.md`, `ROUTER.md`, `README.md`, and eight skills — `zarya-executor`, `zarya-chain`, `zarya-solidity-governance`, `zarya-matrix-report`, `zarya-intents`, `zarya-testing`, `zarya-review`, `zarya-persistence`, `zarya-security`, `zarya-hexagonal`.

The validator gained two checks. It now parses the Solidity sources and **fails if their external surface stops matching the ABI**, which is the check that would have caught a stale source drop or an un-recompiled ABI. And doc symbol resolution now accepts source-declared symbols, extended to capitalised names so an event or error rename is caught — previously only lowercase-initial identifiers were checked, so the entire error taxonomy was uninspected.

## Evidence

```text
npm run ai:validate → exit 0   (16 skills, 38 documents, 7 worklog, 3180 lines, 70 ABI symbols cross-checked)
npm run typecheck   → exit 0
npm run lint        → exit 0
```

Findings were established by query against the source, not by reading impressions:

- Source-vs-ABI surface: 40 external/public functions plus 2 public state variables against 42 ABI functions; empty symmetric difference both directions.
- `approvalPercentageBase`: 8 read sites, 0 write sites across all five `.sol` files; `_votingEligibilityParametersByOrgan` assigned at exactly two places, `.quorum` and `.approvalPercentage`.
- Region encoding: all 98 enum members mapped to their `toString` codes — 48 coincide, 50 differ, 2 exceed the enum bound. Concrete mis-addressing computed for Chechnya (code 95 → Lugansk), Krym (82 → Moscow), Perm (59 → Pskov).
- Access control: every `external` function's modifiers and body scanned for guards; `createThemeVoting` and `createStatementVoting` came back with none.
- Library linking: `contracts/Zarya.json` has empty `linkReferences` because the addresses were substituted at compile time, and `metadata.settings.libraries` names all four. That is what makes the `ValueAdded` conclusion evidence rather than inference from the `external` keyword.

The three new validator checks were verified by fault injection, each restoring the file afterwards: renaming an external function in the source fired both drift messages; renaming a function in the ABI fired both from the other side; citing a nonexistent error in a reference fired the symbol check. The validator returned to exit 0 after restore.

## Unverified

**Everything here is read from source, not from the chain.** The deployed bytecode is the authority, and no Sepolia read was made — the repository has no chain library, no provider configuration, and no test runner. The source matching the ABI and the artifact's metadata naming these files is strong evidence they describe the deployment, but it is not the same as observing the behavior.

Defect 1 is the one worth confirming before anyone acts on it, because it is the most consequential and the cheapest to check behaviorally: create an organ voting, vote unanimously in favor, execute, and observe `VotingFinalized(success = false)`. No read can confirm it — `approvalPercentageBase` is not exposed for any organ, which is part of why it went unnoticed.

Defect 2's permanence is likewise inferred from `finalized` never being set on the revert path. Confirming it means executing a quorum-failed voting twice and seeing the identical revert.

Whether the deployed contract is the version in `temporal_docs/` at all is unproven. The source is dated 2026-06-11 and the ABI agrees with it, but an intervening redeploy from different source would satisfy neither check.

Nothing in this slice was executed against a running app — the Electron binary is still not installed — and no code was written, so none of the client-side guidance added here has been exercised.

## Follow-ups

- Decide the defect 1 response. `IMPLEMENTATION_ORDER.md` recommends building the read-only and theme/statement paths first and naming the limitation in UI, but whether the product ships against a contract that cannot execute most of its governance is the user's call.
- Confirm defects 1 and 2 against Sepolia once a chain library exists. Both are single-transaction checks.
- The organ reverse-table enumeration bound is still open, though smaller than previously thought: three organ types contribute one entry each, two contribute 98, and only the two local types need a number range.
- `UnauthorizedAccess` is declared in `Votings.sol` and never raised. Harmless, but it suggests an authorization path that was planned and dropped — worth asking about if the contract is revised.
