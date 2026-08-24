---
name: zarya-electron-architecture
description: Implement or review Electron main, preload, renderer, and background-worker architecture for the Zarya desktop client. Use for IPC, window and tray lifecycle, worker supervision, file dialogs, executor status wiring, or moving privileged logic out of the UI layer. Not for Solidity or parser-only tasks.
---

# Zarya Electron architecture

Read `__ai/references/ARCHITECTURE.md` for the target layout. Boundary rules are in `__ai/references/INVARIANTS.md` under "Electron trust boundary".

The renderer is UI, not a trusted execution environment. The main process owns OS capabilities and supervises workers. Blockchain work must be independently restartable and must not depend on renderer lifetime.

## Current state

`src/main.ts` is the unmodified scaffold. Two things need fixing when this area is first touched:

- `openDevTools()` runs unconditionally, including in packaged builds. Make it dev-only.
- `webPreferences` sets only `preload`. Set `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` explicitly, so a later edit cannot silently weaken them.

`src/preload.ts` is empty — the typed surface below is the thing to build there.

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

## UI separation

Three separate concerns, three surfaces. Form buttons issue templates — one per supported operation, no signer, no chain write — alongside the matrix report button, which belongs with them because it is what a voter reads *before* choosing a form. The batch panel shows returned forms and intentional actions, including any tamper disclosure. The executive panel shows mechanical execution health; `Run now` requests reconciliation, not direct execution of a chosen voting.

Issuance, ingestion, and report generation all do real work off the UI thread and belong in the worker, not in a renderer handler. The matrix report is the widest read in the app — many calls across many cells — so it must report progress and stay cancellable rather than blocking the window.

## Tests

At minimum: the renderer cannot reach Node, raw IPC, or signing primitives; IPC payloads are validated; a worker restart causes reconciliation; closing and reopening a window duplicates neither worker nor queue; `Run now` calls the same service the automatic triggers use; and issuing a form requires no signer and writes only through the mediated save dialog.
