# Trim the AI package and drop the build artifact

## Ask

Two requests in one slice. First: in the AI docs, remove text that could be dropped without hurting the documentation or the skills. Second, mid-slice: delete the root `contracts/` folder — it is not going to be used anywhere.

## Changes

**The artifact.** `git rm contracts/Zarya.json` (222 KB). It was the full build artifact — bytecode, metadata, method identifiers — kept outside the bundled tree since 2026-08-23. Nothing in `src/` imported it; only documentation cited it, and only as *evidence* for two claims: the four linked library addresses, and that `temporal_docs/` holds the source this artifact was built from. Both facts were already transcribed into `DEPLOYMENT.md`, so removing the file loses the provenance but not the finding. The citations now say the addresses were read from the artifact's `metadata.settings.libraries` before it was dropped, rather than pointing at a path that no longer resolves.

One check had to move with it. The validator's cross-link regex covered `contracts/[A-Za-z0-9_.]+` and asserts every such backticked path exists, and three **worklog** entries cite `contracts/Zarya.json` in their narrative. Worklog is append-only, so rewriting them was not an option — the fix was to drop `contracts/` from the link pattern, leaving `__ai/` and `src/chain/abi/` covered. History can name a file that no longer exists; current references cannot.

**The trim.** 428 lines deleted against 198 inserted, across 23 documents. What came out, by category:

*Exact duplication across files.* The `internal`/`external` library-split explanation — why `ValueAdded` and three errors are missing from the ABI — appeared at full length in seven places. It now lives once in `CONTRACT.md` and is a sentence plus a pointer everywhere else. Same treatment for the region-encoding trap and the basis-points warning, which `CONTRACT.md` alone stated twice.

*Duplication inside one file.* `CONTRACT.md`'s closing "Invariants worth testing" list was thirteen items, every one of which restated a case already in `zarya-solidity-governance` or `zarya-testing`; replaced with a two-way pointer. `STATE_MACHINES.md` explained the two rejection paths twice, once inline at `UNEXECUTABLE` and again in a trailing section. `zarya-review` asked whether `InsufficientVotes` is treated as retryable in two separate bullets. `zarya-solidity-governance` argued the missing eligibility getter as item 4 and again as a following paragraph.

*Restructuring where the shape was the problem.* `DOCUMENTATION_STATUS.md` went from 78 lines to 35. Its stated job is prose that contradicts the code, but five of its eight numbered sections had drifted into re-deriving contract behavior that `CONTRACT.md` and `CONTRACT_DEFECTS.md` already own. It is now a table of prose line → verdict, which is what the file is for.

*Self-justification.* `zarya-hexagonal`'s four-point argument for why the architecture pays off here, `__ai/README.md`'s explanation of why skills are not generated, and the essay framing around several defect entries. The conclusions stayed; the persuasion went.

*Contract-side advice sitting in a client-side reference.* `CONTRACT_DEFECTS.md` carried a proposed Solidity fix for the enable-flag defect that `zarya-solidity-governance` already carries as its item 2. Reduced to one sentence and a pointer.

**Three drift fixes found while reading, not asked for but not leavable.** `USE_CASES.md` row 9–10 still listed `castVote(votingId, support, organ)` in the call column while the criteria three lines below correctly said the call takes no organ. `zarya-repo-bootstrap` claimed the repository has no Solidity source and four open documentation questions, both false since 2026-08-24, and pointed at `contracts/`. `zarya-testing` said contract tests "require Solidity source, which this repository lacks". Stale text is worse than verbose text, so these were corrected rather than trimmed around.

**What was deliberately not touched.** The worklog, which is append-only. `CLAUDE.md`, whose content was audited for exactly this on 2026-08-24 and is now rules plus non-obvious behaviors, with nothing left that is self-evident. `INVARIANTS.md`, `USE_CASES.md` tables, `STATE_MACHINES.md` state lists, and `ARCHITECTURE.md`'s port inventory — dense by construction, where a cut line is a lost rule or a lost test target.

## Evidence

```text
$ npm run typecheck
> tsc --noEmit
(no output — clean)

$ npm run lint
> eslint --ext .ts,.tsx .
(no output — clean)

$ npm run ai:validate
AI package OK — 16 skills, 40 documents (9 worklog), 3123 lines, 71 ABI symbols cross-checked.
```

Before the slice the same validator reported 3353 lines; the count excludes the deleted artifact, which is not markdown. Structure, skill frontmatter, cross-reference resolution, UTF-8 integrity, worklog shape, stale terminology, the address single-source rule, and doc-vs-ABI and source-vs-ABI conformance all still pass, so no trimmed line took a live symbol citation or a resolvable path with it.

## Unverified

- **Whether every cut was genuinely redundant is a judgement, not a check.** The validator proves no cited contract symbol or `__ai` path was orphaned; it cannot prove that a sentence removed from `zarya-pdf-forms` is still recoverable from `INVARIANTS.md`. The reconstruction was done by reading both sides, not by tooling.
- **`contracts/Zarya.json` is recoverable from git history** (`b51608d`), so the deletion is reversible. Not re-verified by checkout.
- **The linked library addresses in `DEPLOYMENT.md` now have no in-repo source.** They were correct when transcribed on 2026-08-24 and nothing has changed since, but re-confirming them would require the artifact back or a block-explorer read.
- No application code changed, so typecheck and lint passing says nothing beyond the docs being inert to them. There is still no test runner.
