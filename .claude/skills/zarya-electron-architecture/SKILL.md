---
name: zarya-electron-architecture
description: Implement or review Electron main, preload, renderer, and background-worker architecture for the Zarya desktop client. Use for IPC, window and tray lifecycle, worker supervision, file dialogs, executor status wiring, or moving privileged logic out of the UI layer. Not for Solidity or parser-only tasks.
---

# Zarya Electron architecture

Read `__ai/references/ARCHITECTURE.md` for the target layout. Boundary rules are in `__ai/references/INVARIANTS.md` under "Electron trust boundary".

The renderer is UI, not a trusted execution environment. The main process owns OS capabilities and supervises workers. Blockchain work must be independently restartable and must not depend on renderer lifetime.

## Current state

Phase 1 built this layer (2026-08-24). What exists, and the pattern to follow when extending it:

- `adapters/electron/windowOptions.ts` — `buildWindowPlan()` is **pure** and returns both the options and whether to open DevTools. `contextIsolation`, `nodeIntegration`, `sandbox`, `webSecurity`, `webviewTag`, and `devTools` are all set explicitly and asserted in a test, so weakening one fails a check rather than shipping.
- `adapters/electron/contentSecurityPolicy.ts` — a pure policy builder, injected as a `<meta>` tag by `vite.renderer.config.ts`. `script-src 'self'` in development too; Vite's dev server does not need `unsafe-inline` or `unsafe-eval`, which was verified by running under it.
- `adapters/electron/ipcContract.ts` — channel names, DTO types, and the exposed key list, imported by main, preload, and renderer alike.
- `adapters/electron/ipcHandlers.ts` — handler bodies exported separately from `registerIpcHandlers`, so they are testable without an `ipcMain`. Errors are sanitized on the way out: only messages we authored reach the renderer, the original goes to a main-process reporter.
- `adapters/electron/preloadApi.ts` — `createZaryaApi(ipc)` builds the bridged object; `src/preload.ts` is three lines wiring `ipcRenderer` into it. A test asserts the exposed key set exactly.
- `adapters/electron/workerSupervisor.ts` + `workerHost.ts` — the supervisor takes its spawn function as a parameter and imports no Electron; only `workerHost.ts` knows about `utilityProcess`.

`src/main.ts` is a composition root. Keep it that way: anything with a decision in it belongs in a pure module next door.

## IPC design

For every method: define shared request and response types; expose one purpose-specific preload method rather than a generic `send(channel, payload)`; validate the payload at the receiving boundary; return serializable DTOs, never provider, signer, or database objects; and keep stack traces and secrets out of what reaches the UI.

Suggested surface — adapt to the code that exists:

```ts
interface ZaryaDesktopApi {
  listFormTypes(): Promise<FormTypeView[]>;
  issueForm(req: IssueFormRequest): Promise<IssuedFormView>;
  printMatrixReport(): Promise<ReportView>;
  importForms(): Promise<ImportResult>;
  getBatch(id: string): Promise<BatchView>;
  submitBatch(id: string): Promise<void>;
  getReceipt(operationRef: string): Promise<ReceiptView>;
  regenerateReceipt(operationRef: string): Promise<ReceiptView>;
  getExecutorStatus(): Promise<ExecutorStatus>;
  runExecutorNow(): Promise<void>;
  onExecutorStatus(cb: (status: ExecutorStatus) => void): () => void;
}
```

`issueForm` needs a save dialog and `importForms` an open dialog, both mediated by the main process — the renderer never receives a filesystem path it can act on directly. Issuance returns a view describing what was written, not the file bytes.

Receipts are written by the worker when a transaction confirms, so they appear without a user action. A batch writes to one per-batch directory rather than prompting per form. `regenerateReceipt` re-stamps from stored data and touches no chain.

## Worker supervision

A worker crash sets executor health to `STOPPED` or `DEGRADED`. Restarting must trigger reconciliation immediately — never rebuild correctness from in-memory timers. Keep long-running loops cancellable on shutdown, and avoid spawning a duplicate worker when a window is recreated.

`WorkerSupervisor` already provides this: `start()` is idempotent, `onRestart` fires on every successful start **including the first** (so startup and restart share one reconciliation path — wire `reconcile()` there in Phase 7), `stop()` cancels a pending backoff before killing, and events from a worker the supervisor no longer tracks are ignored. Worker health (`STARTING`/`HEALTHY`/`DEGRADED`/`STOPPED`) is process liveness, *not* executor health — a healthy worker can report a degraded executor, and a rejected voting is a governance outcome rather than a fault.

## UI separation

Three separate concerns, three surfaces. Form buttons issue templates — one per supported operation, no signer, no chain write — alongside the matrix report button, which belongs with them because it is what a voter reads *before* choosing a form. The batch panel shows returned forms and intentional actions, including any tamper disclosure. The executive panel shows mechanical execution health; `Run now` requests reconciliation, not direct execution of a chosen voting.

Issuance, ingestion, and report generation all do real work off the UI thread and belong in the worker, not in a renderer handler. The matrix report is the widest read in the app — many calls across many cells — so it must report progress and stay cancellable rather than blocking the window.

## Tests

At minimum: the renderer cannot reach Node, raw IPC, or signing primitives; IPC payloads are validated; a worker restart causes reconciliation; closing and reopening a window duplicates neither worker nor queue; `Run now` calls the same service the automatic triggers use; and issuing a form requires no signer and writes only through the mediated save dialog.
