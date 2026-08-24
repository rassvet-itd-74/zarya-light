# Zarya AI router

Skill *selection* comes from each skill's `description` in `.claude/skills/`. This file adds the reading **order** for work that spans domains, and where not to guess.

Source-of-truth precedence is in the root `CLAUDE.md`, which is always in context.

## Procedure

1. **Inspect before routing.** Read the tree and the relevant existing code. Do not assume the repository matches the documentation.
2. **Read `references/CONTRACT.md`** whenever governance semantics matter.
3. **Read `references/CONTRACT_DEFECTS.md`** before implementing anything touching execution outcomes, organ encoding, preflight authorization, or error classification.
4. **Load 1–3 skills**, more only for genuinely cross-cutting work. Load references on demand.
5. **State the invariants you are relying on** before editing anything touching chain writes, persistence, form interpretation, or process boundaries.
6. **Place code by the hexagon** — domain, application service, or adapter — before writing it. `zarya-hexagonal` and `references/ARCHITECTURE.md`.
7. **Implement one coherent slice**, then run the relevant checks.
8. **Report mismatches** between documentation and code explicitly. Never silently adapt one ABI shape into another.
9. **Finish with evidence and a worklog entry.** `zarya-worklog`.

`zarya-hexagonal` applies to any change that adds or moves a module; `zarya-worklog` applies at the end of every slice.

## Reading order for cross-domain work

**Form-driven governance action** (the main pipeline) — `zarya-pdf-forms` → `zarya-intents` → `zarya-chain` → `zarya-transactions` → `zarya-testing`. Add `zarya-batch-engine` when more than one form is imported at once. Do not load executor rules; this is not post-deadline finalization.

**Template issuance from a UI button** — `zarya-pdf-forms` → `zarya-electron-architecture` → `zarya-persistence`. Issuance persists the operation before handing the file over, and needs no signer.

**Matrix reference report** — `zarya-matrix-report` → `zarya-chain` → `zarya-electron-architecture`. The coordinate index projects from the executor's existing event cursor. Not a form, so `zarya-pdf-forms` is not involved.

**Quorum or approval configuration** — `zarya-intents` → `zarya-chain` → `zarya-transactions` → `zarya-testing`. Three setters, not independent: an organ whose base is zero ignores the other two, so submit all three as one operation. Values are basis points.

**Executive status and `Run now`** — `zarya-executor` → `zarya-persistence` → `zarya-electron-architecture` → `zarya-testing`. `Run now` triggers reconciliation, never a blind `executeVoting`.

**Stuck executive transaction after restart** — `zarya-persistence` → `zarya-transactions` → `zarya-executor` → `zarya-chain`.

**Voting eligibility behavior** — `zarya-solidity-governance` → `zarya-chain` → `zarya-testing`. Test snapshot-at-creation and exact threshold boundaries.

## Stop conditions

Do not guess when one of these materially affects the code. Inspect first; ask only when inspection cannot resolve it.

- A defect's client-side workaround would change what the product *does*, not just how it reports — e.g. relabelling or hiding an outcome the chain produced. That is a product decision.
- Which deployment the configured address points at. Two incompatible ones exist — the 2026-08-24 redeploy takes a two-argument `castVote`, its predecessor three. `DEPLOYMENT.md` names the discriminator.
- The enumeration bound for the organ reverse table, where a local organ number range must be chosen.
- A form field's meaning is not covered by the schema in `zarya-pdf-forms`, and adding it would change the intent model.
- A transaction would need a privilege the configured signer model does not represent.
- A request would cause automatic voting rather than form-authorized voting.
- A request would require mainnet or real funds.

## Task templates

Starting prompts: `templates/IMPLEMENTATION_TASK.md`, `templates/BUG_TASK.md`. Review requests go through the `zarya-review` skill.
