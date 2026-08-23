# Zarya `__ai` package

Project knowledge for the Zarya DAIO Electron client: routing policy, stable references, and task templates. Governance documents are PDF AcroForms the app both issues and ingests.

**Skills are not here.** They live in `.claude/skills/zarya-*/SKILL.md`, where Claude Code reads them natively. There is no generation step and no installer — a single canonical copy per skill, so the two cannot drift.

## Layout

```text
CLAUDE.md                     always-loaded hard rules (repository root)
.claude/skills/zarya-*/       15 task skills
__ai/ROUTER.md                which skills and references a task needs
__ai/references/              stable project facts
__ai/worklog/                 append-only record of each slice of work
__ai/templates/               starting prompts
__ai/scripts/                 validator
```

The app is built hexagonally — domain core, ports it owns, adapters that implement them. `references/ARCHITECTURE.md` holds the port inventory and layout; the `zarya-hexagonal` skill holds the discipline, and an ESLint override enforces the dependency direction.

## References

| File | Contents |
| --- | --- |
| `CONTRACT.md` | The contract surface, derived from the ABI. Signatures, organ encoding, error taxonomy, and what is **not** exposed |
| `DOCUMENTATION_STATUS.md` | Where docs and ABI disagree; the four questions still open and what would close each |
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

Checks structure, skill frontmatter, cross-reference resolution, UTF-8 integrity, worklog entry shape, stale terminology, and — most importantly — that every contract symbol the docs cite actually exists in `src/chain/abi/Zarya.abi.json`. Documentation drift fails the check instead of surfacing during implementation.

`npm run lint` additionally enforces the hexagonal dependency direction inside `src/domain/`.

## Starting a session

For a broad task:

> Read `__ai/ROUTER.md` and `__ai/references/DOCUMENTATION_STATUS.md`, inspect the repository, route this task, plan, and implement the next coherent slice with tests.

Or invoke a skill directly: `/zarya-chain`, `/zarya-executor`, `/zarya-review`, and so on.

## State of the ground truth

The ABI (`src/chain/abi/Zarya.abi.json`, 42 functions, 12 events, 16 errors) settles the contract surface. `temporal_docs/` is the supplied product documentation and contains known-stale lines — `DOCUMENTATION_STATUS.md` records which.

Two things are worth knowing before planning any work:

1. **Four contract questions remain open** and need Solidity source or a live Sepolia read: rejection semantics, Chairman cross-organ voting, zero-vote execution, and region encoding. The first materially changes executor design; the last is cheap to resolve and blocks all organ handling.
2. **The document format is ours.** Governance documents are PDF AcroForms the app issues and ingests, so the schema is a product decision in `zarya-pdf-forms` rather than something to reverse-engineer. Owning it does not make a returned form trustworthy — see the trust rule in `INVARIANTS.md`.

## Principles

1. `ROUTER.md` is the orchestration policy; the root `CLAUDE.md` holds the rules.
2. References store stable facts; skills store procedures.
3. The ABI decides what exists. Report mismatches instead of reconciling them silently.
4. A user's explicit current requirement can require changing code — implement it deliberately with tests rather than pretending existing code already matches.
5. Sepolia is the only permitted live network unless the user explicitly says otherwise.
