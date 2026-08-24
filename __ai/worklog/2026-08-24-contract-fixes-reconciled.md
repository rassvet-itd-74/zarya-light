# Reconcile the AI package with the contract fixes

## Ask

The contract defects were fixed. Re-read `temporal_docs/`, alter the AI docs where applicable, extract the ABI from the artifact because the artifact is too large to sit in the bundled tree, and remove the defects reference if the issues are resolved.

## Changes

**ABI extraction.** A new full build artifact had been dropped into `src/chain/abi/` under the artifact's own name (217 KB, 43 functions) and the trimmed ABI was gone. Extracted the bare `abi` array back to `src/chain/abi/Zarya.abi.json` (36 KB) and moved the artifact to `contracts/Zarya.json`, which is where `DEPLOYMENT.md` already says it belongs — outside the bundled tree, so deploy bytecode and metadata cannot reach a renderer bundle. The previous artifact there was the stale build from the day before and was superseded.

**Four defects confirmed fixed**, matching the user's own summary: the `setMinimumApprovalPercentageBase` setter plus a `_getEligibilityParams` fallback to `simpleMajority`; `castVote` scoped to the voting's stored `governingOrgan` with the caller-supplied argument removed; a `totalVotes == 0` guard ahead of the approval division; and `votingId == 0` rejected by the existence guard. Eligibility also moved to basis points, which the user's note explains as a rounding-error fix — 1% truncation error at base 100 could fail a borderline vote, 0.01% at base 10 000 cannot.

**Three defects survive**, so the reference stays rather than being deleted:

- **Quorum failure is still permanent.** `InsufficientVotes` reverts without setting `finalized`, so the voting stays past-deadline, unfinalized, and rediscovered on every reconciliation pass. The zero-vote fix made the error clean but routed *more* votings into this state rather than fewer.
- **Region ordinals still are not subject codes.** `Regions.sol` was not touched.
- **The approval base now doubles as a silent enable flag** — new, and a direct consequence of the fix. `_getEligibilityParams` returns `simpleMajority` *in its entirety* when the base is zero, so `setMinimumQuorum(organ, 10)` on its own is discarded and the organ still uses a quorum of 1. Setting the base later activates the previously written value. With no eligibility getter, none of this is observable.

Plus one new client-side gap: **a voting's `governingOrgan` has no getter.** `castVote` now depends on it, and nothing exposes it, so vote preflight must recover the organ from creation events. That makes the event projection load-bearing for `castVote` — not just for deadline discovery and the matrix index — and a voting with no projection entry must read as "eligibility undetermined" rather than "open to anyone".

**One flagged item turned out to be intended.** I had recorded fully-open theme and statement voting as a defect; the user's note confirms `ZERO_PARTY_ORGAN` means "open vote, no organ restriction" by design. Reclassified: it is now an access-control fact in `CONTRACT.md` and a locked decision in `DECISIONS.md`, with the consequence stated plainly — at a quorum of 1, one address can create, vote on, and execute a theme voting alone.

**Switched `CONTRACT_DEFECTS.md` to named sections.** Nineteen numbered citations across twelve files pointed at defects 1-7, and four of those defects had just been fixed; renumbering would have rotted every one. This is the same failure `USE_CASES.md` had with letter-prefixed sections, and the same fix: reference by name. The file now leads with a fixed-on-2026-08-24 table so a reader who remembers the old numbering can find where things went.

Updated to match: `CLAUDE.md` gotchas, `CONTRACT.md` (43 functions, access control, `castVote` signature, execute-path table, eligibility resolution, not-exposed, errors, invariants), `DOCUMENTATION_STATUS.md`, `STATE_MACHINES.md`, `DECISIONS.md`, `IMPLEMENTATION_ORDER.md` (Phase 0 residue is gone — nothing blocks the phases now), `USE_CASES.md`, `ROUTER.md`, `README.md`, and nine skills.

**Validator gained an arity check.** The name-only comparison had passed `castVote` cleanly while its argument count went from three to two — the exact drift that breaks every generated call site. It now compares parameter counts for every external function and fails on a mismatch. This was found by the stale ABI, not by inspection: the check reported the missing setter but stayed silent on `castVote`.

## Evidence

```text
npm run ai:validate → exit 0   (16 skills, 39 documents, 8 worklog, 71 ABI symbols cross-checked)
npm run typecheck   → exit 0
npm run lint        → exit 0
```

The drift check earned its place before anything was rewritten. Run against the ABI as delivered, it failed with `temporal_docs/Zarya.sol exposes setMinimumApprovalPercentageBase() but the ABI does not` — the ABI in the tree had not been recompiled from the new source. After extraction from the new artifact: 43 external/public source symbols against 43 ABI functions, empty symmetric difference, and no arity mismatch.

Each finding was established by query, not by reading impressions:

- `_getEligibilityParams` returning the whole `simpleMajority` struct — read directly at `Zarya.sol:496-504`, and the enable-flag consequence follows from `setMinimumQuorum` writing only `.quorum`.
- `governingOrgan` assigned in exactly six places (`Votings.sol:169` onward), never for theme or statement, and matched against the ABI: no function name or output type exposes it.
- Access control re-extracted from every `external` function's modifiers and body, rather than assumed unchanged — which is what showed `castVote` skipping the check entirely on organless votings.
- The new arity check was fault-injected by adding a third parameter back to `castVote` in the source; it reported `castVote() takes 3 argument(s) in temporal_docs/Zarya.sol but 2 in the ABI`, and the file was restored.

## Unverified

**The defects reference was not deleted, because three of its seven entries are still live** and one is new. It shrank rather than going away. It can go when quorum failure finalizes, region ordinals stop diverging from subject codes, and the base stops standing in for a configured flag.

Everything remains read from source. No Sepolia read has been made — still no chain library, provider, or test runner — so none of the fixed behavior has been observed, only read.

**The bigger risk now is deployment skew, and it is worse than before.** `contracts/Zarya.json` is a build artifact, not proof of what is live at the configured address, and its `metadata.settings.libraries` lists the same four library addresses as yesterday's build. If the deployed Zarya predates these fixes, a client built against the two-argument `castVote` sends malformed calldata to it. Confirm the deployment before relying on any fixed behavior. This is now recorded as a stop condition in `ROUTER.md`.

The enable-flag reading of `_getEligibilityParams` is a source reading with a behavioral consequence I could not test: that `setMinimumQuorum` followed by no base leaves a voting snapshotting quorum 1. It follows directly from the code but deserves the two-transaction check.

Whether open theme and statement voting is acceptable at a quorum of 1 is a governance question, not a client one. Recorded, not resolved.

## Follow-ups

- Verify the deployed contract includes these fixes before writing chain code against them.
- Confirm the enable-flag behavior with two transactions once a chain library exists.
- The three surviving defects are all fixable contract-side; `zarya-solidity-governance` now ranks them, with quorum-failure finalization first because it would let the client drop the local suppression list entirely.
