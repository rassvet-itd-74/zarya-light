---
name: zarya-repo-bootstrap
description: Orient within the Zarya repository before implementing a cross-cutting feature. Use when starting a major slice, entering unfamiliar territory, or when documented architecture may differ from current code. Not for a small local edit whose surrounding code is already understood.
---

# Zarya repository bootstrap

Build an evidence-based implementation map before editing. Do not scaffold a parallel architecture without first finding what exists.

## Current state — read this before searching

The app is an unmodified `electron-forge` Vite + TypeScript scaffold:

```text
src/main.ts        scaffold; DevTools always on, webPreferences minimal
src/preload.ts     empty
src/renderer.ts    scaffold; stylesheet import commented out
src/chain/abi/     Zarya.abi.json — the contract authority
contracts/         Zarya.json — full build artifact, not bundled
temporal_docs/     supplied product documentation
```

There is **no** Solidity source, chain code, form code, PDF library, persistence, test runner, or test suite in this repository. Do not spend time searching for them.

Checks that exist: `npm run typecheck`, `npm run lint`, `npm run ai:validate`.

## Procedure

1. Read `__ai/ROUTER.md` and `__ai/references/CONTRACT.md`. The contract surface is already recorded from the ABI — do not re-derive it.
2. Read `__ai/references/DOCUMENTATION_STATUS.md`. Four questions are open; determine whether the task depends on any of them before designing anything.
3. Inspect the actual tree for what the task touches. Note the package manager, config conventions, and available checks.
4. Compare reality against `__ai/references/ARCHITECTURE.md` and `IMPLEMENTATION_ORDER.md`.
5. Produce a short implementation map: components to reuse, components missing, risky mismatches with exact paths, the first coherent slice, and the tests that will prove it.
6. Only then edit.

## Rules

- Adapt existing patterns rather than introducing a second framework or library stack.
- Do not replace the package manager, linting, or build tooling without a concrete need.
- If the repository already implements a later phase, start from current state rather than following the phase order mechanically.
- Cite exact file paths and functions when reporting a mismatch.
- Do not support both an old and a new contract ABI shape unless multi-version compatibility is an explicit requirement.

## Two facts that shape most plans

- **Both halves are specified.** The contract by its ABI; the PDF AcroForm schema by us, in `zarya-pdf-forms`. Nothing is blocked on external input. Chain reads come first only because template pre-fill depends on them.
- **Region encoding is unresolved and cheap to resolve.** `getPartyOrganIdentifier` is `pure`. Any task involving organs should settle it first — every organ-addressed call depends on it.
