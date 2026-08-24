# Zarya AI router

Skill *selection* is handled by the `description` field of each skill in `.claude/skills/` — this file does not duplicate it. What it adds is the reading **order** for work that spans domains, which references to load, and where not to guess.

## Procedure

1. **Inspect before routing.** Read the tree and the relevant existing code. Do not assume the repository matches the documentation.
2. **Read `references/CONTRACT.md`** whenever governance semantics matter. It is derived from the Solidity source and settles what older notes left open.
3. **Read `references/CONTRACT_DEFECTS.md`** before implementing anything touching execution outcomes, organ encoding, preflight authorization, or error classification. Seven contract behaviors there contradict what the product documentation implies, and each says what the client must do anyway.
4. **Load 1–3 skills**, more only for genuinely cross-cutting work. Load references on demand, not up front.
5. **State the invariants you are relying on** before editing anything touching chain writes, persistence, form interpretation, or process boundaries.
6. **Place code by the hexagon** — domain, application service, or adapter — before writing it. `zarya-hexagonal` and `references/ARCHITECTURE.md`.
7. **Implement one coherent slice**, then run the relevant checks.
8. **Report mismatches** between documentation and code explicitly. Never silently adapt one ABI shape into another.
9. **Finish with evidence and a worklog entry:** changed files, checks run and their results, unresolved risks, next dependency. `zarya-worklog`.

## Source of truth

Two different questions — do not use one precedence list for both.

**What exists now:** `temporal_docs/Zarya.sol` and its libraries → `src/chain/abi/Zarya.abi.json` → `temporal_docs/` prose → `__ai/`. Deployed bytecode outranks all of them; a claim read from source is read from source, and says so. The ABI alone is not sufficient — externally-linked library events and errors are missing from it.

**What the product should become:** the user's explicit current requirement. If it differs from current behavior, identify the mismatch, then change source and tests deliberately.

## Always in scope

`zarya-hexagonal` applies to any change that adds or moves a module — load it whenever the question "where does this code go?" arises. `zarya-worklog` applies at the end of every slice.

## Reading order for cross-domain work

**Form-driven governance action** (the main pipeline) — `zarya-pdf-forms` → `zarya-intents` → `zarya-chain` → `zarya-transactions` → `zarya-testing`. Add `zarya-batch-engine` when more than one form is imported at once. Do not load executor rules; this is not post-deadline finalization.

**Template issuance from a UI button** — `zarya-pdf-forms` → `zarya-electron-architecture` → `zarya-persistence`. Issuance persists the operation before handing the file over, and needs no signer.

**Matrix reference report** — `zarya-matrix-report` → `zarya-chain` → `zarya-electron-architecture`. The coordinate index projects from the executor's existing event cursor; organ labels need the reverse table. Not a form, so `zarya-pdf-forms` is not involved.

**Quorum or approval configuration** — `zarya-intents` → `zarya-chain` → `zarya-transactions` → `zarya-testing`. Chairman preflight checks `isMember` against the Chairperson organ, then simulates. Three setters, not independent: an organ whose base is zero ignores the other two, so submit all three as one operation. Values are basis points.

**Executive status and `Run now`** — `zarya-executor` → `zarya-persistence` → `zarya-electron-architecture` → `zarya-testing`. `Run now` triggers reconciliation, never a blind `executeVoting`.

**Stuck executive transaction after restart** — `zarya-persistence` → `zarya-transactions` → `zarya-executor` → `zarya-chain`.

**Voting eligibility behavior** — `zarya-solidity-governance` → `zarya-chain` → `zarya-testing`. Test snapshot-at-creation and exact threshold boundaries.

## Stop conditions

Do not guess when one of these materially affects the code. Inspect first; ask only when inspection cannot resolve it.

The contract questions that used to live here are settled — read `CONTRACT_DEFECTS.md` rather than re-deriving them. What remains genuinely open:

- A defect's client-side workaround would change what the product *does*, not just how it reports — e.g. relabelling or hiding an outcome the chain produced. That is a product decision.
- Which deployment the configured address points at. Two incompatible ones now exist — the 2026-08-24 redeploy takes a two-argument `castVote`, its predecessor three — so verify the interface before writing rather than discovering it on a real vote. `DEPLOYMENT.md` names the discriminator.
- The enumeration bound for the organ reverse table, where a local organ number range must be chosen
- A form field's meaning is not covered by the schema in `zarya-pdf-forms`, and adding it would change the intent model
- A transaction would need a privilege the configured signer model does not represent
- A request would cause automatic voting rather than form-authorized voting
- A request would require mainnet or real funds

## Task templates

Starting prompts: `templates/IMPLEMENTATION_TASK.md`, `templates/BUG_TASK.md`. Review requests go through the `zarya-review` skill.
