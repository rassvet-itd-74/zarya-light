# TypeScript toolchain upgrade and tsconfig modernization

## Ask

Fix the editor warnings. Initially unspecified which; investigation showed a flood of `tsc` errors plus two deprecation notices on `tsconfig.json`.

## Changes

The error flood was thousands of `TS1005`/`TS1109` **syntax** errors inside `node_modules/@types/node` — TypeScript 4.5.5 (Dec 2021) cannot parse `@types/node` 26.2.0. `skipLibCheck: true` did not help because it skips type-*checking* of `.d.ts` files, not *parsing* them.

Two compounding causes: `@types/node` was not a declared dependency at all (hoisted transitively via `jest-worker`), and [tsconfig.json](../../tsconfig.json) had no `include` or `types`, so TypeScript auto-loaded every `@types/*` package in the tree.

- `typescript` `~4.5.4` → `~5.9.3`. Not TS 7 — typescript-eslint v8 caps at `<6.0.0`.
- `@typescript-eslint/*` `^5.62.0` → `^8.67.0`.
- Added `@types/node` `^22.20.1` explicitly rather than inheriting whatever hoists.
- Added `"types": ["node"]` plus explicit `include`/`exclude`. The `types` array is what prevents recurrence; imported packages still resolve their own typings normally.
- Left `eslint` at 8.57.1 deliberately. ESLint 9/10 require migrating to flat config, and typescript-eslint v8 supports `eslint ^8.57.0`, so the legacy `.eslintrc.json` keeps working. That is a migration, not a warning fix.

Then the deprecations: removed `baseUrl` outright (no `paths` map depended on it), moved `moduleResolution` from `node`/node10 to `bundler` with `module: ESNext` (correct here — all three entries are bundled by Vite per `forge.config.ts`), and replaced the vestigial `outDir` with `noEmit: true` since nothing emits via `tsc`. Chose migration over `"ignoreDeprecations": "6.0"`, which expires in TS 7 anyway.

TS 7 then surfaced `TS2882` on the `./index.css` side-effect import, which node10 resolution had silently tolerated. Fixed by referencing `vite/client` in `forge.env.d.ts`.

## Evidence

```text
tsc 5.9.3 (workspace)   → exit 0
tsc 7.0.2 (cross-check) → exit 0
eslint                  → exit 0
```

Cross-checked against TS 7.0.2 specifically because that is the compiler emitting the deprecation notices — it is what confirmed they were gone rather than merely quiet, and what found the CSS import.

## Unverified

`@types/node` `^22` is an assumption. Electron 43's bundled Node version could not be confirmed because `node_modules/electron/dist` is absent — npm is withholding install scripts, so the Electron binary was never downloaded. That also means `npm start`, `package`, and `make` cannot run, and nothing here was verified against a running app.

## Follow-ups

- `strict` is still off in tsconfig — only `noImplicitAny`.
- Approve install scripts so the Electron binary downloads.
- ESLint 9/10 flat-config migration.
