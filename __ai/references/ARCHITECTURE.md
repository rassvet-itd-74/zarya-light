# Target architecture

Hexagonal — ports and adapters. Dependencies point inward; the domain core defines what it needs and never knows what supplies it. The discipline for working in this shape is the `zarya-hexagonal` skill; this file is the concrete inventory.

```text
        driving adapters (call in)
   ┌──────────────────────────────────────┐
   │  Electron IPC   executor scheduler   │
   │  renderer UI    tests                │
   └────────────────┬─────────────────────┘
                    v
             application services
        IssueTemplate · ImportForms · SubmitBatch
        ReconcileExecutions · RegenerateReceipt · PrintMatrixReport
                    v
   ┌──────────────────────────────────────┐
   │            domain core               │
   │  intents · organs · identity         │
   │  batch / executor state machines     │
   │  classification · threshold rules    │
   │            ports (interfaces)        │
   └────────────────┬─────────────────────┘
                    v
        driven adapters (called out to)
   chain · forms/PDF · store · secrets · fs · clock
                    v
              Sepolia / Zarya
```

## Directory layout

```text
src/domain/          no imports from electron, chain, PDF, storage, or node:*
  primitives.ts      branded UnixSeconds, ChainId, EvmAddress, OperationRef
  network/           the Sepolia-only rule as a pure predicate
  intents/
  organs/
  batches/
  executor/
  ports/             interfaces the domain owns
src/app/             use cases that orchestrate ports
src/adapters/
  chain/             viem; abi/, network guard, clock, revert decoding
  forms/             PDF library; issue, parse, receipt, and the shared field schema
  store/             database, migrations
  electron/          IPC contract and handlers, preload surface, dialogs,
                     window options, CSP, worker supervision and protocol
  config/            environment → PublicConfig + SecretConfig
  platform/          IdGenerator over node:crypto
src/main.ts  src/preload.ts  src/renderer.ts  src/worker.ts
```

`src/main.ts` is a composition root and decides nothing. Anything with a rule in it lives in the domain, a use case, or an adapter, where it is testable without launching Electron — which is why window options, the CSP, and the IPC handler bodies are pure functions with their Electron wiring kept separate.

The ABI lives at `src/adapters/chain/abi/Zarya.abi.json`, where the adapter that reads it does. It moved there in Phase 2 from `src/chain/`, so worklog entries before 2026-08-24 name the old path.

The field-name schema lives in `adapters/forms/` and is shared by all three form directions. It is an adapter detail: the domain receives typed intents and never sees a field name.

`src/domain/**` import restrictions are enforced by an ESLint override in `.eslintrc.json`. The directory exists, so the guard is live — observed rejecting Electron, `node:*`, the ABI, and an adapter import.

## Ports

Driven ports — the domain declares these, adapters implement them.

| Port | Responsibility | Adapter |
| --- | --- | --- |
| `VotingReader` | active, finalized, results, `hasVoted` | chain |
| `MembershipReader` | `isMember` | chain |
| `OrganResolver` | triple → `bytes32` for calls, and `bytes32` → label for display; both via `pure` helpers, cacheable forever | chain |
| `MatrixReader` | cell organ, allowed categories, decimals, themes, statements, history | chain |
| `MatrixIndex` | which coordinates exist, projected from the event stream | chain |
| `VotingDiscovery` | `VotingCreated` indexing with a resumable cursor | chain |
| `ChainWriter` | submit, await confirmation, return a decoded outcome | chain |
| `NetworkGuard` | chainId, contract code, eligibility fingerprint, and `castVote` arity — four distinct verdicts, plus `UNREACHABLE` for "could not tell" | chain — *implemented* |
| `Clock` | **chain block time**, never workstation time | chain — *implemented* |
| `TemplateWriter` | generate a pre-filled AcroForm | forms |
| `FormParser` | returned PDF → neutral parsed fields, or a structural rejection | forms |
| `ReceiptStamper` | fill `zarya.receipt.*` and flatten | forms |
| `MatrixReportWriter` | render the coordinate reference PDF — no form fields | forms |
| `OperationStore` | issued templates keyed by `operationRef`, with authoritative context | store |
| `BatchStore` | batches, items, dependency edges | store |
| `TransactionStore` | attempts, nonces, hashes, receipts, classified errors | store |
| `CursorStore` | discovery block cursor | store |
| `Signer` | sign; never exposes key material | secrets |
| `FileSink` | write a file to a user-chosen or configured location | electron |
| `IdGenerator` | `operationRef` creation | platform — *implemented* |

Driving adapters call application services: IPC handlers, the executor's periodic trigger, the manual `Run now` action, and tests. All executor triggers converge on one `reconcile()` use case.

## Trust boundaries

Boundaries the architecture enforces structurally rather than by convention:

- The **renderer** is untrusted UI. It reaches the app only through a narrow typed preload surface, never raw IPC, a filesystem path it can act on, a signer, or a database handle. Its CSP forbids inline, remote, and `eval`'d script, in development as well as production — the renderer will eventually display text extracted from untrusted forms, and a policy only active in packaged builds is a policy nobody exercises. It is delivered as a `<meta>` tag injected by the renderer's Vite config, because the packaged app loads over `file://`, where a `webRequest` response header is not dependably applied.
- The **domain** cannot read a PDF, because it has no PDF type. The untrusted-form rule is therefore not a discipline the domain has to remember.
- **Secrets** live behind `Signer`. No adapter returns key material, and no port exposes it.
- The **worker** owns long-running and failure-prone work — chain calls, form generation and parsing, the transaction queue, reconciliation. It may crash and restart without losing correctness, because state is persisted and reconciled rather than held in memory.

The rules behind these are in `INVARIANTS.md`.

## Pipelines

Three flows share infrastructure and must not share authorization semantics.

**Template issuance** — no signer, no chain write. Persists the operation before the file leaves the app.

```text
chain reads + user selection -> template spec -> AcroForm PDF -> FileSink
```

**Intentional form pipeline** — proposal creation, `castVote`, and privileged configuration.

```text
returned PDF -> parse -> recover context by operationRef -> normalize -> validate
             -> preflight -> queue -> sign -> broadcast -> confirm -> reconcile
             -> stamp receipt
```

App-authored context enters from `OperationStore`, never from the file.

**Mechanical executor** — never changes eligibility policy, never casts a vote.

```text
discover voting -> check deadline and finalized -> enqueue execution
               -> sign -> broadcast -> confirm -> reconcile
```

**Receipt stamping** hangs off confirmation, never broadcast, and is regenerable from stored data without a chain write.

**Matrix report** — a read-only reference PDF with no form fields, so it cannot re-enter the form pipeline. No signer, no chain write. The coordinate index is a second projection over the cursor `VotingDiscovery` already maintains, not an independent sweep.

```text
MatrixIndex projection + per-cell reads + organ reverse table
  -> report model (domain) -> MatrixReportWriter -> FileSink
```
