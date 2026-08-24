# Rotate the deployment address and clarify three defects

## Ask

Remove the defects reference if the issues are resolved. Plus: the region is a string, not an ordinal; and the enable-flag and missing-getter entries were not understandable. New deployment address supplied.

## Changes

**The defects file stays.** Re-checked the current source rather than relying on the previous pass: `Votings.sol` still sets `finalized` only after the approval test, so a quorum-failed voting is still permanently unexecutable; `Regions.sol` is untouched since May; `_getEligibilityParams` is unchanged. `Zarya.sol` had a newer timestamp at identical size, and its external surface, guards, and setters are byte-identical to what is documented — 43 functions matching the ABI with no arity drift. Three defects live, plus the missing-getter gap, so deleting the file would strand the reasons behind the executor's suppression list, region-ordinal validation, three-value threshold writes, and the event projection being load-bearing for votes.

**Reworded the region entry, because the wording caused the misreading.** The old heading — "Region ordinals are not subject codes" — read as a denial that a string is involved, when a string very much is: `getPartyOrganIdentifier` returns one, and the identifier the contract hashes is `"74.СОВ"`. The entry now leads with a table of the two representations and where each lives, then makes the actual point: the **argument** is `uint8` (`enum Regions.Region` in the ABI, so a string cannot be passed), the subject code is what `toString` renders that number into, and the two numbers differ for 50 of 98 regions because `toString` is a 98-branch lookup rather than an arithmetic conversion.

**Expanded the enable-flag entry** from an assertion into a four-row walkthrough of what a Chairman configuring "10 voters, 66%" actually gets: two transactions that succeed and change nothing, then a third that activates values written earlier. Added the one-field-default fix in code, since "default only the base" is easier to see than to describe.

**Expanded the missing-getter entry** to say *why* a getter rather than only that one is absent: the client needs the organ to answer "may I vote on this, and if not why", the two alternatives are per-render simulation (no organ name, one round trip each) or an event index (backfill from deployment, gap risk), and the failure mode is what earns it — "no organ" is a real value meaning *anyone may vote*, so an unknown organ must never default to absent or a non-member is told they are eligible.

**New address.** `DEPLOYMENT.md` now carries `0x6b31cC58…`, with the previous deployment named as predating the fixes and expecting the three-argument `castVote`. Two mutually incompatible deployments now exist, so the note tells Phase 2 to verify the *interface* rather than just that the address has code, and names a `castVote` arity probe as the discriminator. Updated the stop condition in `ROUTER.md` and the Phase 2 note in `IMPLEMENTATION_ORDER.md` from "the deployment may predate the fixes" to "two exist, check which".

**Generalised the validator's address check.** It pinned the old address as a literal, which meant this redeploy would have silently retired it — the check would have looked for a string that no longer appears anywhere and passed trivially. It now matches addresses by shape and fails on any full address outside `DEPLOYMENT.md`, so the invariant survives every future redeploy.

## Evidence

```text
npm run ai:validate → exit 0   (16 skills, 40 documents, 9 worklog, 71 ABI symbols cross-checked)
npm run typecheck   → exit 0
npm run lint        → exit 0
```

- Confirmed the region argument's type from the ABI rather than from the source alone: `getPartyOrgan` inputs are `uint8 organType /* enum PartyOrgans.PartyOrganType */`, `uint8 region /* enum Regions.Region */`, `uint256 number`. There is no string-typed region parameter anywhere on the surface.
- Source-vs-ABI re-run after the newer `Zarya.sol`: 43 external/public symbols against 43 ABI functions, empty symmetric difference, no arity mismatch.
- Confirmed every address in the package lives in `DEPLOYMENT.md` before tightening the check, then fault-injected one into `DECISIONS.md` — the new check reported it and named the file. Restored.
- The symbol checker caught two genuine gaps in the same edit: `getVotingOrgan()`, a function proposed rather than existing, and `keccak256()`, a Solidity builtin. Both declared rather than worked around.

## Unverified

**The deployment is unverified.** Fetching the Etherscan page returned HTTP 403 — Etherscan blocks automated requests — and there is no configured RPC, no chain library, and no API key in this repository. So I cannot confirm that the code at `0x6b31cC58…` is the source in `temporal_docs/`, nor that it is verified on-chain. Everything about deployed behavior remains read from source.

This matters more than it did before the redeploy, not less: two incompatible deployments now exist, and the failure is quiet on the read path but breaks writes. A `castVote` arity probe against the configured address would settle it in one call once a provider exists.

The enable-flag walkthrough is derived from source, not executed. The four rows follow directly from `_getEligibilityParams` returning the whole struct, but no transaction has demonstrated them.

## Follow-ups

- Probe the deployed interface as the first thing Phase 2 does, and record the result here.
- When the remaining defects close, fold the `Matricies` quirks into `CONTRACT.md` and delete `CONTRACT_DEFECTS.md`.

## Picking this up next session

Written at the end of 2026-08-24 for whoever resumes. No code has been written yet — this is still a documentation and contract-analysis package on an unmodified Electron scaffold.

**Expected first input:** the user said they would address quorum-failure finalization. If `temporal_docs/` has changed, start by running `npm run ai:validate` — the source/ABI drift and arity checks are the fastest way to see what moved, and they fail loudly if the ABI was not recompiled alongside the source. Then diff the three live entries in `CONTRACT_DEFECTS.md` against the source before editing any prose.

**If quorum failure now finalizes**, the client-side consequences are already mapped and should be applied in the same slice:

- `UNEXECUTABLE` collapses into `FINALIZED_REJECTED` in `STATE_MACHINES.md`, and the note anticipating this can go.
- The local suppression list becomes unnecessary — that removes the "one exception to chain-wins" section in `zarya-persistence` and the corresponding row in `zarya-executor`'s outcome table.
- `zarya-transactions`, `zarya-review`, `zarya-testing`, and `USE_CASES.md` all assert `InsufficientVotes` is terminal-and-suppressed; each needs revisiting, not just the reference.

That fan-out is the reason to reconcile in one pass rather than patching the reference alone.

**Still open regardless:** region ordinals versus subject codes (needs a contract-side helper or a reconciliation of the two numbers), the approval base doubling as an enable flag, and the absent `governingOrgan` getter. The last two are small contract changes with outsized client benefit — the getter in particular removes an event-backfill dependency from vote preflight.

**Unfinished business that is not about defects:** the deployment at `0x6b31cC58…` has never been contacted. No chain library, provider, test runner, or PDF library has been chosen, `strict` is still off in `tsconfig.json`, and the Electron binary is not installed, so nothing in this package has been exercised against a running app. `IMPLEMENTATION_ORDER.md` Phase 1 is the entry point when code starts.
