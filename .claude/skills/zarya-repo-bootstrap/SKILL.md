---
name: zarya-repo-bootstrap
description: Orient within the Zarya repository before implementing a cross-cutting feature. Use when starting a major slice, entering unfamiliar territory, or when documented architecture may differ from current code. Not for a small local edit whose surrounding code is already understood.
---

# Zarya repository bootstrap

Build an evidence-based implementation map before editing. Do not scaffold a parallel architecture without first finding what exists.

## Current state — read this before searching

Phase 1 of `IMPLEMENTATION_ORDER.md` is built (2026-08-24): the hexagon, the Electron boundary, a supervised worker, and Vitest.

```text
src/domain/        primitives.ts; network/networkPolicy.ts; ports/{Clock,IdGenerator}
src/app/           getAppStatus.ts
src/adapters/
  config/          appConfig.ts — PublicConfig + self-redacting SecretConfig
  platform/        cryptoIdGenerator.ts
  electron/        ipcContract, ipcHandlers, preloadApi, windowOptions,
                   contentSecurityPolicy, workerSupervisor, workerHost,
                   workerProtocol
src/main.ts        composition root only
src/preload.ts     contextBridge: getAppStatus, onWorkerHealth — nothing else
src/worker.ts      utilityProcess entry; answers ping, hosts Phases 2/6/7
src/assets/        logo.png, favicon.ico
  chain/abi/       Zarya.abi.json — the contract's external surface
temporal_docs/     Zarya.sol plus four libraries, and supplied product prose
```

There is **no** chain code, form code, PDF library, or persistence yet. Do not spend time searching for them.

Checks that exist: `npm run typecheck`, `npm run lint`, `npm test`, `npm run ai:validate`.

## Procedure

1. Read `__ai/ROUTER.md` and `__ai/references/CONTRACT.md`. The contract surface is already recorded from the source — do not re-derive it.
2. Read `__ai/references/CONTRACT_DEFECTS.md`. Three defects are live and shape executor, organ, and configuration code.
3. Inspect the actual tree for what the task touches. Note config conventions and available checks.
4. Compare reality against `__ai/references/ARCHITECTURE.md` and `IMPLEMENTATION_ORDER.md`.
5. Produce a short implementation map: components to reuse, components missing, risky mismatches with exact paths, the first coherent slice, and the tests that will prove it.
6. Only then edit.

## Rules

- Adapt existing patterns rather than introducing a second framework or library stack.
- Do not replace the package manager, linting, or build tooling without a concrete need.
- If the repository already implements a later phase, start from current state rather than following the phase order mechanically.
- Cite exact file paths and functions when reporting a mismatch.
- Do not support both an old and a new contract ABI shape unless multi-version compatibility is an explicit requirement. Two incompatible deployments exist; `DEPLOYMENT.md` says how to tell them apart.

## Two facts that shape most plans

- **Both halves are specified.** The contract by its Solidity source; the PDF AcroForm schema by us, in `zarya-pdf-forms`. Nothing is blocked on external input. Chain reads come first only because template pre-fill depends on them.
- **Organ encoding is settled and easy to get wrong.** `region` is the enum ordinal, not the subject code, and `getPartyOrganIdentifier` is `pure`, so every resolution can be validated for free. Any task involving organs should wire that check in from the start.
