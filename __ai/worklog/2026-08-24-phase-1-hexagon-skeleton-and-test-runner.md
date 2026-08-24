# Phase 1 — the hexagon, the skeleton, and a test runner

## Ask

"Let's pick it up where we left off. What's next?" — with Phase 0 complete and `src/` still the
untouched `electron-forge` scaffold, the answer was Phase 1 of `IMPLEMENTATION_ORDER.md`. Scope was
agreed up front as the full phase rather than a thin skeleton: directory layout, hardened window,
test runner, `Clock`/`IdGenerator` ports, configuration, a supervised worker process, and one real
typed IPC method proving the whole path. Vitest as the runner, `utilityProcess` for the worker, and
the pending documentation-trim diff committed first so the code diff would read against a clean tree.

## Changes

**Committed the doc slice first** (`578bee2`) — 26 files, unchanged from the previous slice's work.

**The hexagon exists and is enforced.** `src/domain/` holds branded primitives (`UnixSeconds`,
`ChainId`, `EvmAddress`, `OperationRef`, each with a validating constructor and no unchecked cast
helper), the `Clock` and `IdGenerator` ports, and `network/networkPolicy.ts` — the Sepolia-only rule
as a pure predicate, and the only place in code where that chain id appears. `src/app/getAppStatus.ts`
is the first use case. `src/adapters/` gained `config/`, `platform/`, and a populated `electron/`.

`Clock` is declared with no implementation on purpose, per `IMPLEMENTATION_ORDER.md`: the chain
adapter supplies one in Phase 2, and retrofitting the port after call sites exist is the expensive
version. Its second implementation today is the test fake.

**Configuration is two types, not one.** `PublicConfig` crosses IPC; `SecretConfig` is main/worker
only and overrides `toString`, `toJSON`, and the Node inspect symbol to yield `[redacted]`. The
concrete reason it exists now rather than in Phase 6: provider URLs carry API keys in the path, so
`PublicConfig` carries `rpcHost` and never the URL. Signer *presence* is reported as two booleans;
no key material is copied anywhere. `loadConfig` fails closed at startup — wrong network, malformed
address, unusable URL, or out-of-range poll interval all refuse to start rather than surfacing at the
first chain call. `Number()` rather than `parseInt` on integers, so `11155111abc` is rejected instead
of silently becoming a valid-looking value.

**The Electron boundary is pure functions plus thin wiring.** `buildWindowPlan` returns the options
and the DevTools decision without touching Electron, so `contextIsolation`/`nodeIntegration`/
`sandbox`/`webSecurity`/`webviewTag`/`devTools` are asserted in a test rather than trusted to a
comment. IPC handler bodies are exported separately from `registerIpcHandlers`; each validates its
payload on arrival, and errors are sanitized outbound — only messages we authored reach the renderer,
the original goes to a main-process reporter. `createZaryaApi(ipc)` builds the bridged object, so
`src/preload.ts` is three lines and a test can assert the exposed key set *exactly*. `src/main.ts` is
now a composition root that decides nothing.

**The worker is a supervised `utilityProcess`.** `WorkerSupervisor` imports no Electron and takes its
spawn function as a parameter; only `workerHost.ts` knows about `utilityProcess`. It owns three
invariants: `start()` is idempotent so a recreated window cannot fork a second worker; `onRestart`
fires on every successful start *including the first*, so startup and restart share one
reconciliation path for Phase 7 to hook; and `stop()` cancels a pending backoff before killing, so
shutdown cannot race a timer into spawning a worker on the way out. Events from a worker it no longer
tracks are ignored, which is what stops a dead predecessor's late `exit` from resurrecting the state.

Messaging goes over `process.parentPort`, not a `MessageChannelMain` pair as the plan sketched. A
channel would allow a port to be handed to the renderer; the parent port means the only route from
renderer to worker runs through main, where payloads are validated.

**A CSP, which was not in the plan.** The app's own DevTools flagged its absence. It earns its place
here rather than in Phase 9 because the renderer will eventually display text extracted from
untrusted PDF forms. Two findings while implementing it:

- Delivered as a `<meta>` tag injected by `vite.renderer.config.ts`, not a `webRequest` header: the
  packaged app loads the renderer over `file://`, where a response header is not dependably applied,
  while a meta tag is part of the document in both modes. One mechanism, one policy.
- `script-src 'self'` holds in **development** too. The first draft allowed `'unsafe-inline'` and
  `'unsafe-eval'` for Vite's sake; testing showed Vite's dev server serves its client and the entry
  as module `src=` scripts and needs neither. Development therefore runs under the production script
  rules, which is the only way a violation gets noticed by someone.

**Tooling.** Vitest 3.2.7 (deduped onto the existing `vite@5.4.21`, no second toolchain), `npm test`
and `npm run test:watch`, a third forge build entry for the worker, and one `.eslintrc.json` addition:
`vitest/config` joined the `import/no-unresolved` ignore list, because the plugin's legacy Node
resolver cannot follow package `exports` subpaths that TypeScript resolves fine.

**Documentation synced as part of the slice**, not after it: `IMPLEMENTATION_ORDER.md`'s state
section and Phase 1, `ARCHITECTURE.md`'s layout and trust boundaries, `CLAUDE.md`'s command list, and
the "current state" sections of `zarya-repo-bootstrap`, `zarya-electron-architecture`,
`zarya-testing`, and `zarya-hexagonal` — all four of which asserted things that were true this
morning and false by evening.

## Evidence

```text
$ npm run typecheck
> tsc --noEmit
(no output — clean)

$ npm run lint
> eslint --ext .ts,.tsx .
(no output — clean)

$ npm test
> vitest run
 ✓ src/adapters/electron/contentSecurityPolicy.test.ts (7 tests)
 ✓ src/domain/primitives.test.ts (22 tests)
 ✓ src/adapters/electron/preloadApi.test.ts (6 tests)
 ✓ src/adapters/platform/cryptoIdGenerator.test.ts (3 tests)
 ✓ src/adapters/electron/windowOptions.test.ts (4 tests)
 ✓ src/domain/network/networkPolicy.test.ts (7 tests)
 ✓ src/adapters/electron/workerSupervisor.test.ts (20 tests)
 ✓ src/adapters/config/appConfig.test.ts (10 tests)
 ✓ src/adapters/electron/ipcHandlers.test.ts (10 tests)
 Test Files  9 passed (9)
      Tests  90 passed (90)

$ npm run ai:validate
AI package OK — 16 skills, 41 documents (10 worklog), 3175 lines, 71 ABI symbols cross-checked.
```

**The import guard was observed firing**, not merely configured. A throwaway
`src/domain/__guard_probe.ts` importing `electron`, `node:fs`, the ABI, and an adapter produced four
distinct `no-restricted-imports` errors with the intended per-category messages, then was deleted.
A guard nobody has seen fire is a guard nobody knows works.

**`npm start`, observed rather than assumed.** All three Vite targets build, including the new worker
entry. The process tree is one `browser`, one `gpu-process`, one `network` utility, and exactly one
`node.mojom.NodeService` — the worker. The window renders the status readout: worker `HEALTHY`,
protocol `v1`, uptime read back through the ping round trip, Sepolia (11155111), the configured
address, `rpc.sepolia.org`, and both wallets correctly reported as not configured. The DevTools
console is clean — no security warning, no CSP violation. `curl http://localhost:5173/` confirms the
injected policy carries `script-src 'self'` in dev.

Closing the window logged the window-close, `will-quit`, and `quit` sequence, and no `electron.exe`
remained afterwards: `supervisor.stop()` took the worker with it, no orphan.

## Unverified

- **No test proves at runtime that the renderer cannot reach Node.** `windowOptions.test.ts` asserts
  the configuration that produces the sandbox, not the sandbox's behavior. Proving the behavior needs
  an Electron-driving harness, which is Phase 10.
- **The production CSP was verified by construction and by the dev-served document, not from a
  packaged build.** `npm run package` was not run, so the `file://` case rests on the meta tag being
  part of the built HTML rather than on an observation of it. Worth confirming at the first packaging.
- **`window-all-closed` on macOS keeps the worker alive deliberately, and that path is untested** —
  no macOS machine here. The Windows path quits, so `activate` never fires and the "reopen a window
  without forking a second worker" case is covered only by the supervisor's idempotency unit test.
- **The default RPC endpoint (`https://rpc.sepolia.org`) has never been contacted.** Nothing in this
  slice makes a network call; whether it is reachable and usable is Phase 2's first question.
- **The contract address default is transcribed from `DEPLOYMENT.md`, not read from chain.** No code
  yet verifies the configured address has code, or which of the two incompatible deployments it is.
- Two harness artifacts, noted so they are not mistaken for defects later: `npm start` from a
  non-interactive shell with stdin at EOF exits immediately, and killing that shell later leaves the
  detached Electron tree running. Neither reflects app behavior.
