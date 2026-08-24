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
  intents/
  organs/
  batches/
  executor/
  ports/             interfaces the domain owns
src/app/             use cases that orchestrate ports
src/adapters/
  chain/             chain library, ABI, error decoding
  forms/             PDF library; issue, parse, receipt, and the shared field schema
  store/             database, migrations
  electron/          IPC handlers, dialogs, window and worker lifecycle
src/main.ts  src/preload.ts  src/renderer.ts
```

The field-name schema lives in `adapters/forms/` and is shared by all three form directions. It is an adapter detail: the domain receives typed intents and never sees a field name.

`src/domain/**` import restrictions are enforced by an ESLint override in `.eslintrc.json`, inert until the directory exists.

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
| `NetworkGuard` | chainId and contract-code identity checks | chain |
| `Clock` | **chain block time**, never workstation time | chain |
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
| `IdGenerator` | `operationRef` creation | platform |

Driving adapters call application services: IPC handlers, the executor's periodic trigger, the manual `Run now` action, and tests. All executor triggers converge on one `reconcile()` use case.

## Trust boundaries

Boundaries the architecture enforces structurally rather than by convention:

- The **renderer** is untrusted UI. It reaches the app only through a narrow typed preload surface, never raw IPC, a filesystem path it can act on, a signer, or a database handle.
- The **domain** cannot read a PDF, because it has no PDF type. The untrusted-form rule is therefore not a discipline the domain has to remember.
- **Secrets** live behind `Signer`. No adapter returns key material, and no port exposes it.
- The **worker** owns long-running and failure-prone work — chain calls, form generation and parsing, the transaction queue, reconciliation. It may crash and restart without losing correctness, because state is persisted and reconciled rather than held in memory.

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

**Matrix report** — a read-only reference PDF with no form fields, so it cannot re-enter the form pipeline. No signer, no chain write.

```text
MatrixIndex projection + per-cell reads + organ reverse table
  -> report model (domain) -> MatrixReportWriter -> FileSink
```

The coordinate index is a second projection over the cursor `VotingDiscovery` already maintains, not an independent chain sweep.
