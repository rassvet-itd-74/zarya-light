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
  primitives.ts      branded UnixSeconds, ChainId, EvmAddress, OperationRef,
                     Bytes32, and the exported Brand helper
  network/           the Sepolia-only rule as a pure predicate
  chain/             what a revert means and what to do about it
  organs/            the 98-region table, the eight organ types, identifier
                     composition — no hashing, which needs a chain library
  voting/            voting ids, suggestion types, the governing-organ tri-state,
                     lifecycle and deadline rules, the discovery window plan
  matrix/            coordinates, cell binding, axis labels, and which matrix a
                     ValueAdded log belongs to
  preflight/         the contract's authorization rules as values, the castVote
                     guard order, the matrix preconditions checked at execution,
                     the client duration bound, and simulation reconciliation
  intents/          the closed allow-listed union, the field readers that build
                    it from raw text, semantic identity, and which
                    AuthorizationRule guards each variant
  batches/
  executor/
  ports/             interfaces the domain owns
src/app/             use cases that orchestrate ports
src/adapters/
  chain/             viem; abi/, network guard, clock, revert and error
                     decoding, organ resolution and the label table, voting
                     reads, event discovery
  forms/             PDF library; issue, parse, receipt, and the shared field schema
  store/             database, migrations; for now an in-memory cursor store
  electron/          IPC contract and handlers, preload surface, dialogs,
                     window options, CSP, worker supervision and protocol
  config/            environment → PublicConfig + SecretConfig
  platform/          IdGenerator over node:crypto
src/testing/         test support only, in no build entry — currently the
                     Solidity source parsers the derived-table tests compare against
src/main.ts  src/preload.ts  src/renderer.ts  src/worker.ts
```

`src/main.ts` is a composition root and decides nothing. Anything with a rule in it lives in the domain, a use case, or an adapter, where it is testable without launching Electron — which is why window options, the CSP, and the IPC handler bodies are pure functions with their Electron wiring kept separate.

The ABI lives at `src/adapters/chain/abi/Zarya.abi.json`, where the adapter that reads it does. It moved there in Phase 2 from `src/chain/`, so worklog entries before 2026-08-24 name the old path.

The field-name schema lives in `adapters/forms/` and is shared by all three form directions. It is an adapter detail: the domain receives typed intents and never sees a field name.

As of Phase 4 slice 1 that directory holds `formSchema.ts` — the field names, `FORM_SCHEMA_VERSION`, and the per-operation split between human-filled and app-authored keys — and `assembleFormInput.ts`, the structural half of ingestion. Neither imports a PDF library, which is why they are testable and why the round-trip test exists before the library does. **`FormParser` is deliberately not declared as a port yet:** a port returning field names would contradict the rule above, and the honest shape only becomes clear once the library that produces them is chosen. The application-facing surface is a function that ends at a typed intent.

`src/domain/**` import restrictions are enforced by an ESLint override in `.eslintrc.json`. The directory exists, so the guard is live — observed rejecting Electron, `node:*`, the ABI, and an adapter import.

The override covers domain **test** files too, deliberately. When domain tests needed to read `temporal_docs/` the fix was `src/testing/`, a module outside both layers that nothing shipped imports — not an exception in the rule, which would have applied to production modules the next time one was added.

Organ hashing is the one place the client computes an organ identifier's `keccak256` itself, and it lives in the adapter because the domain may not import a chain library. That split is not incidental: the *forward* direction resolves through the contract's own `getPartyOrgan`, and the local hash exists only to build the reverse table, which has no getter to build it from.

## Ports

Driven ports — the domain declares these, adapters implement them.

| Port | Responsibility | Adapter |
| --- | --- | --- |
| `VotingReader` | active, finalized, results, `hasVoted`, `highestVotingId`, `exists` — every method returns `undefined` rather than a plausible `false` when it could not read | chain — *implemented* |
| `MembershipReader` | `isMember`, which is also the Chairman check | chain — *implemented* |
| `OrganResolver` | triple → `bytes32` for calls via the `pure` helpers, verified against `getPartyOrganIdentifier` on every resolution; `bytes32` → label from a locally enumerated table, bounded at local organ number 99 and returning `undefined` rather than guessing | chain — *implemented* |
| `MatrixReader` | cell binding, allowed categories, decimals, themes, statements — the metadata preflight needs, read at the **head**. The checkpoint readers belong to the report and are deliberately absent | chain — *implemented* |
| `MatrixIndex` | scans one window for everything the coordinate index folds: the applied pair (`ValueAdded`, `CategoryAdded`) and the gated three (decimals, theme, statement creation) joined to `VotingFinalized`. Scans a window, never decides which, and never gates — `foldMatrixIndexWindow` owns the gating | chain — *implemented* |
| `MatrixSnapshotReader` | every read the report needs, **pinned to one block**: cells, axis labels, per-cell category names, latest checkpoint values. Separate from `MatrixReader` because a document assembled across the moving head can show a pairing that never existed on chain | chain — *implemented* |
| `CallSimulator` | `eth_call` with a sender, for `castVote` and `executeVoting`. Named calls, never raw calldata, so the form pipeline's allow-list has no hole below it | chain — *implemented* |
| `VotingDiscovery` | `VotingCreated` indexing joined to the six organ-bearing detail events; scans a window, never decides which | chain — *implemented* |
| `ChainWriter` | submit, await confirmation, return a decoded outcome | chain |
| `NetworkGuard` | chainId, contract code, eligibility fingerprint, and `castVote` arity — four distinct verdicts, plus `UNREACHABLE` for "could not tell" | chain — *implemented* |
| `Clock` | **chain block time**, never workstation time | chain — *implemented* |
| `TemplateWriter` | generate a pre-filled AcroForm | forms |
| `FormParser` | returned PDF → neutral parsed fields, or a structural rejection | forms |
| `ReceiptStamper` | fill `zarya.receipt.*` and flatten | forms |
| `MatrixReportWriter` | render the coordinate reference PDF — landscape, no form fields, font **subset** because there are no fields for a viewer to regenerate an appearance from. Takes the assembled model and nothing else, so no clock can reach the page | forms — *implemented* |
| `OperationStore` | issued templates keyed by `operationRef`, with authoritative context | store |
| `BatchStore` | batches, items, dependency edges | store |
| `TransactionStore` | attempts, nonces, hashes, receipts, classified errors | store |
| `CursorStore` | discovery block cursor, keyed by chain + address + projection; `commit` never moves backwards | store — *in memory until Phase 5* |
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
MatrixIndex scan -> foldMatrixIndexWindow -> CoordinateIndex
  + MatrixSnapshotReader (pinned) + organ reverse table
  -> assembleMatrixReport (domain) -> MatrixReportWriter -> FileSink
```

The reads are pinned to `head - confirmations` rather than to the index cursor: a cursor mid-backfill needs archive state a public endpoint does not serve, while the confirmed head is both reorg-safe and always available. When the cursor is behind that block the model reports `indexBehindBy` rather than absorbing the gap. A read that fails degrades its own field and keeps the row, since the coordinate is what a voter transcribes; the report fails outright only when it would be nothing but empty rows — the axis inventory is event-derived and survives an outage.
