# Restructure the __ai package and ground it in the ABI

## Ask

Analyze the `__ai` package, then plan and fix it. User chose: make `.claude/skills/` canonical, and trim for token cost alongside the tooling fixes.

## Changes

**Structural.** `install-claude-skills.mjs` prepended an HTML comment ahead of the YAML frontmatter. Claude Code requires frontmatter at the top of `SKILL.md`, so the generated skills never registered — and the package's own validator enforced that exact rule on the canonical copy while the installer violated it. The package had also never been installed: no root `CLAUDE.md`, no `.claude/`. It was entirely inert.

Rather than fix the generator, removed it: the 13 skills moved to `.claude/skills/` and became canonical, so the frontmatter bug, stale wrappers, and content drift are all structurally impossible. Deleted `MANIFEST.txt` (a hand-maintained file listing that duplicated the tree) and `CLAUDE.md.fragment` (superseded by a real root `CLAUDE.md`).

**Grounding.** `src/Zarya.json` arrived mid-slice — a full build artifact. Extracted the `abi` array to `src/chain/abi/Zarya.abi.json` (36 KB) and moved the artifact with its deploy bytecode to `contracts/Zarya.json`, out of the bundled tree.

The ABI settled most of what the package told agents to treat as unknown: `executeVoting` takes **one** argument (the three-arg whitepaper line is stale), organs are `bytes32` from a `pure` helper rather than hashed strings, and the 16 custom errors are the real classification taxonomy that replaced `zarya-chain`'s invented generic categories.

It also contradicted three things the package asserted. Corrected each:
- `STATE_MACHINES.md` claimed a rejected voting ends `FINALIZED_REJECTED` as fact. `InsufficientVotes` is a revert, so the voting may never finalize and a retry loop would hammer a settled political outcome. Demoted to an explicitly unverified assumption.
- `zarya-chain` advised checking Chairman identity before privileged writes. No `getChairman()` exists — preflight must simulate and catch `NotChairman`.
- `CONTRACT.md` suspected no eligibility getter; confirmed absent, so UI cannot display a voting's thresholds at all.

**Trim.** Consolidated `SECURITY_INVARIANTS.md` plus governance rules restated across seven files into one `INVARIANTS.md`; single-sourced the deployment address into `DEPLOYMENT.md`; cut ROUTER's route table, which duplicated what each skill's `description` already does.

## Evidence

```text
npm run ai:validate → AI package OK — 13 skills, 27 documents, 1837 lines, 70 ABI symbols cross-checked
npm run typecheck   → exit 0
npm run lint        → exit 0
```

Fault-injected every validator check. Two were broken as first written and would have shipped silently: the ABI-drift check required an inline backtick so it never read the ```solidity signature blocks (the actual drift surface), and the mojibake detector caught **0 of 9** real samples. Both fixed and re-verified — drift now caught in fences and prose, mojibake at 9/9 with zero false positives against genuine Russian text.

Separately compared all 36 documented signatures against the ABI parameter-by-parameter: every argument list matches.

## Unverified

Whether the skills actually appear in `/help`. Skills load at session start, so this needs a restart; the validator confirms they are structurally valid, which is what the installer broke.

Docs came to 1,837 lines against a ~1,700 target — the duplication removal landed but new ABI content offset part of it.

## Decisions

`.claude/skills/` canonical over thin wrappers: wrappers still duplicate `description` into the wrapper, so partial drift would remain. Promoted to `__ai/README.md`.
