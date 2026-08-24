# Zarya `__ai` package

Project knowledge for the Zarya DAIO Electron client: routing policy, stable references, and task templates.

Skills live in `.claude/skills/zarya-*/SKILL.md`, where Claude Code reads them natively — one canonical copy each, so nothing can drift.

## Layout

```text
CLAUDE.md                     always-loaded hard rules (repository root)
.claude/skills/zarya-*/       16 task skills
__ai/ROUTER.md                which skills and references a task needs
__ai/references/              stable project facts
__ai/worklog/                 append-only record of each slice of work
__ai/templates/               starting prompts
__ai/scripts/                 validator
```

## References

| File | Contents |
| --- | --- |
| `CONTRACT.md` | The contract surface, derived from the Solidity source. Signatures, access control, organ encoding, error taxonomy, and what is **not** exposed |
| `CONTRACT_DEFECTS.md` | Contract behaviors the product documentation does not anticipate, and what the client must do about each |
| `DOCUMENTATION_STATUS.md` | Where `temporal_docs/` prose contradicts the code |
| `DEPLOYMENT.md` | Network, address, artifact paths, signer roles |
| `INVARIANTS.md` | Rules that hold everywhere — privilege separation, trust boundaries, secrets, recovery |
| `DECISIONS.md` | Settled product and architecture choices |
| `ARCHITECTURE.md` | The hexagon: port inventory, directory layout, trust boundaries, pipelines |
| `USE_CASES.md` | Observable behavior and acceptance criteria |
| `STATE_MACHINES.md` | Explicit states for issued templates, forms, operations, batches, executor jobs |
| `IMPLEMENTATION_ORDER.md` | Suggested phases and current repository state |

## Validate

```bash
npm run ai:validate
```

Checks structure, skill frontmatter, cross-reference resolution, UTF-8 integrity, worklog entry shape, stale terminology, and that every contract symbol the docs cite exists in `src/chain/abi/Zarya.abi.json`. Documentation drift fails the check instead of surfacing during implementation.

`npm run lint` additionally enforces the hexagonal dependency direction inside `src/domain/`.

## Starting a session

For a broad task:

> Read `__ai/ROUTER.md` and `__ai/references/DOCUMENTATION_STATUS.md`, inspect the repository, route this task, plan, and implement the next coherent slice with tests.

Or invoke a skill directly: `/zarya-chain`, `/zarya-executor`, `/zarya-review`, and so on.

**Read `CONTRACT_DEFECTS.md` before planning anything.** The contract was fixed on 2026-08-24 and three defects survive; `castVote` also lost an argument, which breaks any call site built against the old form.
