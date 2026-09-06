# Implementation order

Use only when the repository does not already have a more advanced implementation. If a later phase is already built, start from current state.

## Current repository state

**Phases 0 and 1 are complete** as of 2026-08-24; **Phase 2 as of 2026-09-01.**

Phase 0: the Solidity source arrived and closed every open question; the contract surface is in `CONTRACT.md` and the behaviors that surprised us are in `CONTRACT_DEFECTS.md`. Both halves of the product are specified — the contract by its source, the document format by us — so nothing below is blocked on external input.

Phase 1: the hexagon exists and is enforced. `src/domain/` holds `primitives.ts`, the `Clock` and `IdGenerator` ports, and `network/networkPolicy.ts`; `src/app/` holds `getAppStatus`; `src/adapters/` holds `config/`, `platform/`, and `electron/`. `src/worker.ts` runs as a supervised `utilityProcess`, `src/preload.ts` exposes a two-method `contextBridge` surface, and the window sets `contextIsolation`/`nodeIntegration`/`sandbox` explicitly with DevTools disabled outside development. Vitest is the runner (`npm test`), with 90 tests across the domain, config, IPC, preload, CSP, and supervisor.

Still absent: form code, persistence, and a PDF library.

What remains in `CONTRACT_DEFECTS.md` is absorbed by ordinary implementation and needs no decision up front: terminal classification for quorum-failed votings plus their local suppression (Phase 7, and Phase 5 for the storage column); region ordinals and the extended error registry (Phase 2); threshold configuration as one three-value operation (Phase 3); and recovering a voting's organ from creation events, which makes the event projection load-bearing earlier than it would otherwise be (Phase 2).

Two incompatible deployments exist, differing in `castVote`'s arity. Phase 2's identity check should verify the *interface*, not just that the address has code — a `castVote` arity probe is the cheapest discriminator, and getting it wrong surfaces as a failed vote rather than a startup error.

## Phase 1 — the hexagon, the skeleton, and a test runner — **done 2026-08-24**

Established the shape before there was code to misplace. The ESLint import guard has been observed firing on all four of its categories, so the dependency direction is enforced rather than merely configured.

Two things worth carrying forward from how it was built:

- **`Clock` is declared with no implementation.** The chain adapter supplies it in Phase 2. Its only current implementation is a test fake, which is the point — a deadline decision made from workstation time now requires importing something the domain forbids.
- **Configuration is split into `PublicConfig` and `SecretConfig`** rather than one type with a comment. The public half crosses IPC; the secret half redacts itself under `util.inspect`, `JSON.stringify`, and interpolation. Private key material is not in it yet — that arrives with the `Signer` port in Phase 6 — but the redaction it will need is already in place and tested.

Deferred out of Phase 1 with reasons, not by oversight: the `Signer` port and any secret store (Phase 6), and a runtime Electron harness that proves the renderer cannot reach Node (Phase 10 — the current tests assert the configuration, not the sandbox's behavior).

## Phase 2 — chain read adapter and preflight — **done 2026-09-01**

Ahead of the form layer because template pre-fill depends on these reads.

Built in four slices. **Slice 1** — foundation and network guard, 2026-08-24: viem as the chain library, `NetworkGuard` and the `Clock` implementation, and the deployment discriminator. **Slice 2** — organ resolution and the error registry. **Slice 3** — voting reads and discovery. **Slice 4** — the `ValueAdded` fragment, the matrix reads, and preflight.

Five things settled here that bind the rest of the plan:

- **Tests run against a local anvil forking Sepolia.** The real deployed contract, its real linked libraries, and its real state, with nothing compiled here and nothing broadcast — the live network is read once, at fork time. Opt-in via `ZARYA_FORK_RPC_URL`; the suite skips and stays green without it.
- **The identity check is four distinct verdicts, not one.** chainId, contract code, an eligibility fingerprint, and the `castVote` arity probe. `UNREACHABLE` is separate from all of them, because an outage must never be reported as a wrong deployment.
- **A revert's *meaning* is domain, its *decoding* is adapter.** `CallOutcome` has an `UNKNOWN` member with three distinct reasons, so an outage, an empty revert, and an unnameable selector never collapse into a verdict about what the contract decided.
- **The deployment has exactly one voting, and it is the instructive one.** Voting 1 is a membership voting for `74.СОВ` with zero votes, past its deadline and unfinalized — the "Quorum failure is permanent" case, live. Simulating `executeVoting(1)` on the fork reverts `InsufficientVotes`, so the executor's terminal rule is now observed rather than inferred. Anything that changes on that deployment changes these tests.
- **Preflight predicts a revert *name*, and the guard order is part of the prediction.** `castVote` checks the voting's organ before the window, so a non-member looking at an expired voting is refused for membership — confirmed on the fork. Predictions are compared against simulations and the disagreement is reported, because a client stricter than the chain refuses real governance and a stale projection has no other symptom.

- ~~Provider and chainId validation; contract code check.~~ **Done.**
- ~~Organ resolution via `getPartyOrgan`, carrying the structured triple with `region` as an **enum ordinal**, validated against `getPartyOrganIdentifier` on every resolution.~~ **Done** — and the ordinal is a branded type with no numeric route from a subject code, so a form's answer can only become an argument through the table.
- ~~`OrganResolver` both directions, including the `bytes32` → label reverse table.~~ **Done.** The reverse table is local — 297 closed entries plus local organs enumerated to number 99, configurable. An unlisted hash returns `undefined`; the caller shows the hash rather than a guess.
- ~~Error decoding across the ABI's 16 errors **plus** `NoThemeSet`, `NoStatementSet`, `InvalidCategory`, and `Panic(0x11/0x12/0x32)`.~~ **Done**, plus `Error(string)`. Dispositions are `ALREADY_DONE` / `NOT_YET` / `REJECTED` / `TERMINAL`; `InsufficientVotes` and `InvalidOrgan` are the two terminal ones.
- ~~Reads: `isVotingActive`, `isVotingFinalized`, `hasVoted`, `isMember`, `getVotingResults`.~~ **Done**, plus `exists` and `highestVotingId`. Every read returns `undefined` rather than a plausible `false` when it could not read — `VotingNotFound` included.
- ~~`VotingCreated` event indexing with a persisted block cursor — the only source of `endTime`, and the same cursor the matrix coordinate index projects from.~~ **Done**, with the cursor in memory until Phase 5 (`CursorStore` is declared and its monotonicity rule enforced). The window is chosen by `planDiscovery`: 12 confirmations behind head, 5 000 blocks per scan, backfilling from block **11553464** — found by binary search over `eth_getCode`, not transcribed.
- ~~A hand-written fragment for `ValueAdded`, which fires at the Zarya address but is absent from the ABI.~~ **Done**, pinned by a literal topic hash as well as against the declaration, since the topic outlives `temporal_docs/` and a wrong fragment fails by matching nothing. Everything else *is* in the ABI: the `Votings` library's functions are `internal`, so its twelve events survive into it, and only `Matricies`' `external` functions cause absence.
- ~~Chairman-aware preflight: `isMember` against the Chairperson organ for UX, simulation for the decision.~~ **Done.** The contract's five guards are values (`AuthorizationRule`), the Chairman exemption is granted only where the contract grants it — not for the four matrix-configuration votings — and the Chairperson read is not even *made* under a rule that would not use it.
- ~~Tests keyed on a region whose ordinal and subject code differ.~~ **Done** — Chechnya (ordinal 20, code 95) throughout, and the fork test sweeps all 98 regions against the deployed helpers.
- Matrix metadata reads, added because preflight needs them: cell binding, allowed categories, decimals, themes and statements. The checkpoint readers stay out until the matrix report.
- **Found while building this:** an *approved* voting can be permanently unexecutable, because the mutation runs before `finalized = true`. Creation checks none of the matrix preconditions, so preflight warns at proposal time. New entry in `CONTRACT_DEFECTS.md`; Phase 7 owes it executor state distinct from the `InsufficientVotes` suppression, and Phase 4's form templates should surface the warning.

**`temporal_docs/` stays until every phase is done** (confirmed 2026-09-01), and may then be folded into documentation rather than deleted. Nothing in the plan should be reordered to accommodate its removal. The tables derived from it are guarded two ways regardless: the source-parsing tests skip when the sources are absent (`hasSoliditySource`), and what remains is the stronger evidence — the fork tests resolve every region and organ type through the deployed contract, and literal keccak digests, error selectors and event topics pin the local mirrors with no file dependency. **`npm run ai:validate` hard-fails on a missing `.sol`** and cross-checks 912 source symbols, so it needs work if and when the sources do leave — not before.

## Phase 3 — intent model — **done 2026-09-02**

Built in two slices. **Slice 1** — the union, validation, and identity, 2026-09-01. **Slice 2** — the dispatch to contract calls and the simulator arm, 2026-09-02.

Two things settled in slice 2 that bind what follows:

- **There are two closed unions, not one.** `GovernanceIntent` says what a document asks for; `ZaryaWriteCall` says what the contract takes. They differ in arity (one intent, three transactions), in naming (a categorical `category` is the ABI's `value`), and in argument order — and each difference now happens in a named place rather than inline at an encoder.
- **`executeVoting` is absent from the call union too.** Hard rule 3 as a type rather than a rule to remember: the form pipeline cannot express it, and the executor's own call type is disjoint. That means Phase 6's queue takes a union of two call types, and Phase 7 owes the second one.

- ~~Typed allow-listed intent union: the eight `create*Voting` variants, `CastVote`, and explicit privileged configuration.~~ **Done** — eleven variants. The two threshold setters named here became **one** `CONFIGURE_ORGAN_THRESHOLDS` carrying all three values, because the base doubles as an enable flag and three intents would make a silent no-op the default outcome.
- ~~`ExecuteVoting` is **not** a form intent.~~ **Done, by absence.** There is no variant to construct, so the form pipeline cannot reach it — enforcement rather than a rule to remember.
- ~~Organ represented as a structured triple, not a label.~~ **Done**, and the form asks for a **subject code** which becomes an ordinal only through the region table.
- ~~Schema validation separate from normalization separate from chain preflight.~~ **Done.** `buildIntent` does shape only — no chain read, no clock, no storage — so a validation result is reproducible and a failure is never an outage.
- ~~Each variant maps to one `AuthorizationRule` from Phase 2.~~ **Done** in `intentAuthorization.ts`, exhaustive. The organ on a threshold intent is the *target*, not the authorizer, which is the one arm that would be wrong in the obvious way.
- ~~Exhaustive intent-to-adapter mapping with a `never` check so a new variant cannot silently fall through. `CONFIGURE_ORGAN_THRESHOLDS` is the only intent that is not one transaction — it expands to three, and the ordering is the dispatcher's decision.~~ **Done.** The ordering is conditional on the target base, because eligibility is snapshotted at creation and the safe order for enabling a configuration is the unsafe one for resetting it. New subsection in `CONTRACT_DEFECTS.md`.
- ~~`CallSimulator` grows an arm that takes an intent. It takes the **union**, never calldata: a port accepting bytes would put a hole in the form allow-list one layer below where anyone would look for it.~~ **Done** — `forIntent`, with a third result arm: `NOT_ATTEMPTED` keeps "this client could not build the call" apart from "the contract refused", and splits an organ read that failed from one that disagreed, because their retry behavior differs.

## Phase 4 — PDF form schema, issuance, and ingestion — **done 2026-09-05**

Built in slices. **Slice 1** — the field-name schema and the mapping onto domain keys, 2026-09-02. **Slice 2** — the PDF library, the parser, and the hazard refusals, 2026-09-02. **Slice 3** — issuance, the embedded font, and the end-to-end round trip, 2026-09-02. **The Russian wording** — 2026-09-02 and 2026-09-03, 99 slots across both documents, `pendingLabels()` empty. **The matrix report** — three slices, 2026-09-03, with its button on 2026-09-05. **Ingestion hardening and the import path** — 2026-09-05, below.

~~**Receipt field writing is the one thing deliberately outside this phase.** It needs a confirmed transaction, so it belongs with the queue in Phase 6; the `zarya.receipt.*` fields are defined and issued empty from the start, because retrofitting them would invalidate every form already handed out.~~

**Superseded 2026-09-06 (Phase 6 slice 3).** The reasoning was right while the receipt *was* fields — and it stopped holding the moment the receipt became a mark drawn onto the returned page, because a drawn mark needs nothing reserved for it at issuance. There is no longer anything to retrofit. Receipt stamping still belongs in Phase 6, and it still needs a confirmed transaction.

Settled in slice 1 and binding on the rest:

- **The `zarya.input.*` suffix *is* the domain key.** `zarya.input.member` carries `member`, so the form-to-domain mapping is a prefix strip with no table to fall out of date. A hand-maintained map fails silently when a key is renamed on one side; this fails at compile time.
- **`FIELD_PLAN` is hard rule 4 expressed per operation** — which keys a human fills, which the app recovers from its record, and which it reads from chain when the form comes back. `votingId` on a vote is the bound entry that matters: the form's copy is compared rather than used. `decimals` on a numerical value proposal is the sole **`resolved`** entry, read from the cell the member addressed at import — see the 2026-09-04 note below.
- **Bound forms only.** No `operationRef` is a refusal, not a generic blank form. An unbound form would have to take the organ triple from the file, which is what the bound half exists to prevent.
- **The plan is verified against the builder, not against a list.** A `Proxy` records every key `buildIntent` touches and the test asserts the plan provides all of them, so a key added to a builder cannot become a form that can never be completed.

- ~~Define the field-name schema and `schemaVersion` in one module all three directions import.~~ **Done** — `adapters/forms/formSchema.ts`, plus `assembleFormInput.ts` for the structural half of ingestion that needs no PDF library.
- ~~Issuance: template generation from chain context, logo drawn, empty `zarya.receipt.*` fields present, `operationRef` persisted before the file is emitted, reproducible output.~~ **Done** except the persistence, which is Phase 5's — issuance takes an `operationRef` and the caller is responsible for having recorded it. PT Sans is embedded **whole rather than subset**: a subset carries only the glyphs the issuer draws, and a viewer regenerating a field appearance from it would show a member blanks where their own Cyrillic should be. Costs ~327 KB per template and is reasoned, not observed — see the worklog.
- ~~Ingestion: parse `zarya.input.*` only; recover app-authored context from storage; structural refusal for XFA, encryption, flattening, a populated receipt marker, unknown version or field.~~ **Done** across slices 1 and 2, plus duplicate names, unsupported field types, oversized values, and field-count bounds. ~~Still missing: embedded-file and external-reference refusal, decompressed-size and object-depth bounds, and surfacing an appearance that disagrees with `/V`.~~ **All done 2026-09-05** — `pdfHazards.ts` and `fieldAppearance.ts`.
- ~~Round-trip test as the primary check: issue → fill programmatically → ingest → assert the intent matches.~~ **Done for the ingest half** — real PDF bytes through the real parser to all eleven intents. The `issue` end is still a test fixture, not the application's issuer.
- ~~Hostile fixtures per `zarya-pdf-forms`.~~ **Done 2026-09-05** — encrypted, XFA, flattened, truncated, non-PDF, empty, duplicate names, wrong field type, oversized value, JavaScript action, appearance disagreement, no-AcroForm, and now compression bomb, embedded file, external reference (both `SubmitForm` and `URI`), and incremental-update shadowing.

- ~~Pick a library that never executes PDF JavaScript and never fetches remote resources.~~ **pdf-lib 1.17.1**, chosen by probing rather than by documentation, with the two constraints it fails and their mitigations recorded in `DECISIONS.md`. Confined to `src/adapters/forms/` by ESLint, observed firing.

Receipt stamping arrives with the transaction queue in Phase 6, since it needs a confirmed transaction. ~~Define the `zarya.receipt.*` fields here so templates carry them from the start.~~ **Superseded 2026-09-06:** templates carry no receipt fields; the receipt is drawn onto the returned page.

The **matrix reference report** also belongs here: it needs only Phase 2 reads plus a PDF library, and it is the document a voter reads before filling anything. It carries no form fields, so it adds nothing to the ingestion surface.

**Report slice 1 — the read model — done 2026-09-03.** The coordinate index, the pinned snapshot reads, and the report model, with no PDF involved. Four things settled here:

- **The gated half of the index is ordered by finalization, not creation.** `setTheme`, `setStatement` and `setDecimals` emit nothing when they run, so they are observable only as a creation event joined to `VotingFinalized(success = true)` — and because the mutation happens inside `executeVoting`, a theme proposed first and executed last is the one that survives. The fold therefore carries unmatched proposals across windows and resolves "last one wins" by the finalization log's position, `logIndex` included.
- **The report's reads are pinned to one block, `MatrixReader`'s are not.** Two ports rather than one: preflight predicts against the head, a document describes a block. The pin is `head - confirmations`, not the index cursor, because reading state at a mid-backfill cursor needs an archive node.
- **Degradation is per field, total failure is nearly never.** A failed read marks its own field and keeps the row, since the coordinate is what a voter transcribes. The report fails only when it would consist of nothing but empty rows — the axis inventory comes from the events themselves and survives an outage.
- **`ValueAdded`'s missing `isCategorical` is resolved by reading both cells**, and an `AMBIGUOUS` coordinate prints **twice** rather than being guessed at once.

**Report slice 2 — the document — done 2026-09-03.** The `MatrixReportWriter` port, the landscape layout, composition, the pdf-lib renderer, and 37 new wording slots handed to the party as `wording.ru.txt` part two. Four things settled:

- **Composition is separated from rendering**, because an embedded custom font writes glyph identifiers rather than characters — so once a string is in a content stream there is no way to assert it is the string that was meant. Every claim about what the page *says* is tested against `composeMatrixReport`; the renderer only positions.
- ~~**The font is subset here and whole on a form.**~~ **Reversed 2026-09-05**: the report embeds PT Sans whole too, at ~326 KB. The reasoning for subsetting was sound — a report has no fields, so nothing regenerates an appearance and only the drawn glyphs are needed — and pdf-lib's subsetter simply did not produce them, dropping most of the Cyrillic and shipping an unreadable page. Size was never the constraint worth optimising here.
- **A coordinate is never truncated.** Every other cell may be cut to its column — a statement's full wording is in the axis inventory, an author is recognised rather than copied — but a truncated coordinate addresses a *different real cell*. `uint256` allows 78 digits, so an oversized one is printed on its own full-width line above the row.
- **One wording table for both documents.** The report's slots live in `SLOT_ENGLISH` beside the forms', so the party fills one file, `pendingLabels()` lists everything unworded, and one font-coverage check covers both.

**Report slice 3 — the Russian — done 2026-09-03.** All 37 slots worded, so **both documents are now fully worded** (62 form + 37 report) and `pendingLabels()` is empty again. Twenty-three values were corrected on the way through; three mattered beyond style:

- **`reportStatus.anyCategory` arrived as «любая категория»** — the inverse of what the slot means. It is printed when a categorical cell permits *no* category, so the wording would have told a member that a cell accepting nothing accepts everything. Now «Категории не заданы».
- **`reportSentence.degraded` described the marks as «только для чтения»** — read-only, a permission — where the marker is «Не прочитано», a failure. Rewritten to quote the actual marker.
- **`reportMeta.indexedThrough` said «в блоке»** — *in* block N — where the number is the boundary of what has been read. Now «События считаны до блока».

Only the 70pt column headers were ever too long; the 193-character sentences came back with 23% headroom. Full account, including the two proposals still open, in the worklog.

~~Remaining for the report: the UI button with its IPC path plus the `PrintMatrixReport` application service that supplies `indexedThrough` (Phase 9), and someone opening a sample in a real PDF viewer.~~ **Both done 2026-09-05** — `generateMatrixReport` and its button, and a person produced a report from it and read it. Doing so found the font-subsetting defect recorded above.

**Not implementable, and it is the skill that is wrong:** `.claude/skills/zarya-matrix-report/SKILL.md` lists "an approval threshold renders against its own base — `5000` of `10000` shows as 50%" among the report's tests. No eligibility getter exists (`CONTRACT.md`, "Not exposed"), so a threshold cannot be read at all, and nothing in this report is a basis-point value. The basis-point rendering rule still applies where such a value *is* shown — the form hints — and has a test there.

## Phase 5 — persistence

Being built in slices. **Slice 1 (the engine, migrations, the issued-template record, and the durable cursor) is done, 2026-09-02** — taken ahead of Phase 4's matrix report, which is a printed Russian document and was blocked on wording that persistence does not need.

Three things settled in slice 1 that bind the rest:

- **`node:sqlite`, chosen by running Electron.** Electron 43.4.1 bundles Node 24.18.1 and `DatabaseSync` works there, so there is no native module to rebuild for two runtimes — which is what `better-sqlite3` would have cost, twice, plus `plugin-auto-unpack-natives`. The price is that it is experimental and that tests run on a different Node than production; both are recorded in `DECISIONS.md`.
- **The worker owns the database and the main process never opens it.** `ARCHITECTURE.md` already puts the queue, reconciliation, and form work in the worker; a second handle in main would mean two processes writing one file for no gain. Status reaches the UI over the worker protocol.
- **A form binds only against a record from the *same deployment*.** Nothing downstream reads the chain id or contract from a returned file, so the record is the only thing that says which deployment an operation belongs to — and two incompatible deployments exist. Without the check, repointing the app and importing an old form would build a valid intent for the wrong contract.

- ~~Schema and migrations~~ **Done** — `PRAGMA user_version`, append-only list, each migration transactional with its own version bump; a newer schema is refused rather than migrated downwards.
- ~~Issued-template records keyed by `operationRef`~~ **Done**, with the state machine from `STATE_MACHINES.md` enforced on every transition and uniqueness enforced by the primary key rather than an application check.
- ~~Event cursor~~ **Done** — `SqliteCursorStore`, with `MemoryCursorStore` kept and both held to one shared contract suite. Block numbers are stored as TEXT because `node:sqlite` returns an INTEGER column as a `number`.
- ~~Form hashes and semantic operation identity; stored form bytes~~ **Done 2026-09-05, schema v2** — `identity_key`, `vote_direction`, `form_hash`, `form_bytes` on `operations`, all nullable because an operation that was only ever issued has no returned form. Written by `recordReturn`, which moves the state with them in one transaction; two statements would leave a `RETURNED` row that cannot regenerate its receipt, or an `EMITTED` row that dedups against itself. Identity is the canonical string from `operationIdentity.ts`, not a digest — the domain may not import `node:crypto`, and a string is stable, distinct, and readable in a database. Receipt path and hash stay for Phase 6, which is what writes them.
- Batch and item states; dependency representation.
- Transaction records: chain, contract, signer, assigned nonce, last known receipt and block, classified error and status.
- Executor voting job, with the unique constraint on `(chainId, contractAddress, votingId)`. Deliberately absent so far rather than created as a table with no writer.
- Resume and re-import tests; the five crash windows.

Issuance already depends on this: the `operationRef` it takes is now resolvable, and `boundOperation.ts` is where a stored record becomes the context ingestion assembles against.

**The remaining items are tables whose writers do not exist yet** — transaction records (Phase 6), batch and item states (Phase 8), the executor job (Phase 7, and already noted above as deliberately absent). They stay unbuilt on the same reasoning: a table with no writer is machinery nothing exercises, which is what the vertical slices have repeatedly shown to hide defects. Slice 2 built only what import could drive.

### 2026-09-05 — slice 2: semantic identity and the returned form

Dedup by `operationRef` only ever caught the same *file* twice. Semantic identity catches two forms, issued separately, asking the chain for the same thing — a member who mislaid a template and reissued it has two references and one intention.

- **A vote's identity excludes its direction, so `FOR` and `AGAINST` collide.** That collision is the mechanism: two forms voting opposite ways on one voting are a contradiction to surface, not two operations to submit. `vote_direction` is stored *beside* the key so a caller can tell the same vote again from the opposite one — `DUPLICATE_OPERATION` against `CONFLICTING_VOTE`.
- **The signer is not in the key.** `zarya-intents` names it, there is no `Signer` port until Phase 6, and hard rule 8 is one wallet per installation — so within a database it is a constant, and a constant distinguishes nothing. It belongs there when the client can hold two.
- **A numerical value carries its scale in the key.** `1234` at two decimals and `12340` at three are the same quantity; a key holding only the integer would call them different operations.
- **Components are length-prefixed, not delimiter-joined.** Any separator chosen to be improbable is a bug waiting for a governance statement that contains it.
- **Identity is derived from the built intent, not from the form**, so two documents filled differently that mean the same thing collide, and a form whose values did not validate never reserves an identity.

## Vertical slice — issuance wired end to end — **done 2026-09-03**

Taken out of order, deliberately, and out of Phase 9's UI work. Phases 2–5 had built a chain adapter, an intent model, a form pipeline and a storage engine that were **reachable only from tests**; `npm start` could report status and check the network and nothing else. Rather than stack a third untested layer on two others, one path was wired: a button, a save dialog, a recorded operation, a PDF on disk.

`FileSink` and `TemplateWriter` are now declared and implemented, `issueOperationTemplate` is the first application service that changes anything, and the worker protocol is at v3.

Three things running the app found that no test would have:

- **The worker was never being built for Node.** Vite derives its built-in list from `module.builtinModules`, which on Node 22 does **not** contain `node:sqlite`, so it resolved to a browser stub and `worker.js` was never emitted — presenting as a restart loop. It had been latent since Phase 1 because the worker had no `node:*` import until it opened a database.
- **A startup error on every launch since Phase 1.** `pushWorkerHealth` sends before the first frame commits; `isDestroyed()` is false and `send` throws anyway. Electron logs it itself, so a `try`/`catch` silences nothing — main now tracks `did-finish-load`.
- **The worker's console output never reaches the terminal in dev**, despite `stdio: 'inherit'`. An observability gap, not a malfunction; the database had to be verified by opening the file.

**Found by trying to issue one:** `CREATE_NUMERICAL_VALUE_VOTING` could not be issued at all. `FIELD_PLAN` called its `decimals` bound — "the scale the cell had when the template was issued" — while listing that operation's `x` and `y` as member-filled, so at issuance there was no cell to read a scale from. Both statements were in the same file. The code refused with `BOUND_VALUE_UNAVAILABLE` rather than inventing a scale. **Resolved 2026-09-04** — see below.

Evidence is five rows in the real database at `%APPDATA%/zarya-light/zarya.db`, all `EMITTED`, with organ identifiers the deployed contract rendered (`15.0.СОВ`, `15.КОН`) and subject codes — never ordinals — in `boundValues`.

Still unwired: **preflight**. The matrix report button and the import path were both wired on 2026-09-05 — see below.

### 2026-09-04 — `FIELD_PLAN` gains a third category

The contradiction above was settled by adding **`resolved`** beside `input` and `bound`: keys the application reads **from chain at import**, for the coordinate the form supplied. `decimals` on a numerical value proposal is the only one, read as `numericalCell(at).decimals`.

Why this rather than binding the coordinate at issuance or letting the member type the scale:

- The scale is a property of the **cell**, not of the form and not of the record. At issuance no cell has been chosen, so there was never anything to record.
- `x` and `y` stay member-filled, which is what the matrix reference report exists to support.
- It is **stronger than binding**, not weaker. A scale recorded at issuance goes stale while a form sits on a desk for a week; a scale read at import cannot. `12.34` means twelve-point-three-four at whatever precision the cell holds now.
- Letting the form state its own scale was rejected: `addValue` has no argument for the scale, so nothing on chain could catch a value off by a factor of a hundred, and the client check would be load-bearing rather than advisory — against hard rule 6.

Consequences to know:

- `assembleFormInput` stays pure and its `input` map is therefore **deliberately incomplete** for that one operation. Callers merge `resolvedKeysFor(operationType)` in before `buildIntent`; iterate the schema rather than special-casing the type.
- **Ingestion of a numerical value form now needs a chain read**, so an RPC outage becomes an import refusal for it alone.
- `unavailableBoundKeys` is now empty for all eleven. The mechanism is kept, and `formSchema.test.ts` asserts every bound key has an issuance-time source, so the next one added without one fails the suite.
- **The residual window is import → mined, and nothing closes it.** A decimals voting executing in that gap leaves the submitted integer scaled by the old precision. `GovernanceIntent.decimals` carries the scale that produced the value so a submission-time check can compare it against the cell; **no such check exists yet**, and Phase 6 is where it belongs.

### 2026-09-05 — the matrix report button, and the report path end to end

The read model (2026-09-03, slice 1), the landscape document (slice 2) and the Russian wording (slice 3) all existed and **nothing called any of them**. This slice is the caller: `generateMatrixReport` in `src/app/`, a `generateMatrixReport` worker request, an IPC channel, a preload key, and a button.

Decisions this fixes, all of which the next reader has to know:

- **The projection is rebuilt from the deployment block on every press, and deliberately ignores the discovery cursor.** `CursorStore` persists a block number; the *folded* index is not durable anywhere. Resuming from a stored cursor without the state that produced it would skip every earlier event and print a matrix missing coordinates, with nothing on the page to disclose the omission. A partial index is not a slow report, it is a wrong one. Phase 7's executor is what makes an incremental index possible.
- **The pin is chosen first and bounds the scan.** `ZaryaMatrixSnapshot.atConfirmedHead` pins at `head - confirmations`, and the projection runs `[deployment, pinned]` with `planDiscovery`'s `confirmations` set to **zero** — the depth is already applied, and re-applying it would leave the index twelve blocks short for no gain. `indexedThrough` is therefore exactly the pin, and `indexBehindBy` is always `undefined` on this path; the field is for Phase 7, where the index comes from a cursor that can lag.
- **A failed scan fails the report.** Folding what arrived and printing the rest is the one degradation that cannot be disclosed, because a coordinate never found leaves no gap. Read failures are different — a row exists to carry the marker — and those are printed.
- **The worker request timeout is now per request.** The supervisor's ten seconds is a *liveness* figure and also marks the worker `DEGRADED`; a report is unbounded work that grows with the chain's height and the matrix. `supervisor.request(spec, { timeoutMs })`, five minutes for this one call.
- **`WORKER_PROTOCOL_VERSION` is 4.** The `reported` reply carries `blockNumber` as a **decimal string** — a `bigint` does not survive the structured clone — and carries `degradedRows`, so the UI cannot claim a success the document itself contradicts.

Measured against the real deployment on 2026-09-05: eighteen `eth_getLogs` windows over 88,798 blocks, **1,064 ms**, one page, and this application's own ingestion answers `REJECTED`. The matrix is **empty** on that deployment — no coordinates and no axis labels — so that timing is a floor with no cell reads in it, and the populated layout has still never been rendered from real data.

**The button was then pressed, and the report came out unreadable** — pdf-lib's font subsetting had dropped most of the Cyrillic, on every report since 2026-09-03. Fixed by embedding PT Sans whole; see the entry above and `DECISIONS.md`. The lesson is the one that generalises: every test in `renderMatrixReport.test.ts` asserted only that rendering **did not throw**, and a missing glyph draws as nothing and throws nothing. The test best placed to catch it asserted the file was *small*, which was the symptom.

### 2026-09-05 — ingestion hardening, and import wired end to end

The last two things Phase 4 owed. **Hardening** closed five gaps and added the four missing hostile fixtures; **import** gave the return half a caller, which it had never had.

Both were designed by probing pdf-lib rather than reasoning about it, and the probe changed both answers:

- **A compression bomb is bounded before the library sees the file.** Measured: 200 MB of spaces compresses to 204 KB — **1029×** — so the 4 MiB file cap alone permits roughly 4 GB of inflate. pdf-lib never touches a *content* stream (4 ms, no allocation) but does inflate an **object stream** during `load`, so a check on the loaded document would run after the allocation it prevents. Every Flate stream is therefore inflated on the raw bytes under `zlib`'s own `maxOutputLength`. `LZWDecode` is not covered and is recorded rather than papered over.
- **The object-depth bound protects our own traversal, not the library.** pdf-lib was probed at depths of 100, 1 000, 10 000 and 100 000 and never overflowed a stack; at 10 000 it fails to parse and throws, already reported as unreadable. The bound exists because the hazard walk added here recurses over untrusted structure.
- **Attachments and outward actions are refused** — `/Filespec`, `/EF`, `/EmbeddedFiles`, `/FileAttachment`, and the `URI`/`GoToR`/`Launch`/`SubmitForm`/`ImportData` family. Not because they could steer a decision, but because **Phase 6 stamps a receipt onto the returned file and hands it back out**, so anything left in it is re-published over this application's name. `SubmitForm` is the one that matters most on a form.
- **PDF JavaScript is still tolerated**, as it always has been. The re-emission argument applies to it equally, so this is now an inconsistency rather than a settled position — flagged for the product owner rather than changed unilaterally.
- **An appearance that disagrees with `/V` is a disclosure, not a refusal.** `/V` stays authoritative. Two refinements make the signal worth reading: `/NeedAppearances` skips the comparison entirely, and an **empty** appearance counts as "not established" — that is the shape a viewer leaves when it sets a value without redrawing, it is the common case, and reporting it would put a tamper warning on every filled field of every legitimate import.

Import itself is `importReturnedForm`, a `FileSource` port, `NodeFileSource`, `describeIntent`, an `importForm` worker request, an IPC channel, a preload key, and a review panel. `WORKER_PROTOCOL_VERSION` is **5**.

- **`resolved` keys are read from chain between assembly and building**, iterated from the schema rather than special-cased. An unreadable cell is a **refusal**: `addValue` takes no decimals argument, so a guessed scale is a valid transaction storing a number off by a power of ten.
- **`RETURNED` is set last, and only if an intent was built.** Anything that fails leaves the operation in `EMITTED` so the member can fix the file and import it again — an outage must not burn the operation.
- **A second copy is refused, not imported twice.** `bindOperation` resolves a `RETURNED` record deliberately, so a stale copy finds the completed operation instead of looking unbound; naming that state is what turns it into an answer.
- **A `bigint` never crosses a process boundary.** `describeIntent` flattens the union to strings, and the reply guard refuses a numeric field value — a coordinate read as a number addresses a different cell.

## Phase 6 — serialized transaction queue and receipt stamping

Being built in slices. **Slice 1 — the lifecycle, its persistence, and recovery — done 2026-09-05. Slice 2 — receipt stamping — done 2026-09-06.**

Signer abstraction; send/wait/receipt flow; nonce-safe sequential writes; crash-state reconciliation across the five crash windows. Optional signed outbox only after the basic lifecycle is stable.

### 2026-09-05 — slice 1: the write lifecycle

`Signer`, `ReceiptReader`, `WriteCallEncoder` and `TransactionStore` ports; schema v3's `transactions` table; `submitOperation` and `reconcileTransactions`; viem adapters for signing and receipts.

- **`ChainWriter` became two ports, split along secrets.** Signing needs key material and reading does not, so recovery can ask what a nonce did with no wallet in scope — which is what lets "reconcile before sending" be a rule rather than a chore.
- **No signed outbox, and that is a security decision.** A persisted raw signed transaction is a bearer instrument in a file a backup copies; `zarya-transactions` permits storing them only if the security model accepts it, and this one does not. The cost is stated: after an ambiguous broadcast this client cannot rebroadcast identical bytes, so it recovers **by nonce**.
- **`PENDING` is never `FAILED`.** No edge exists. An unread receipt is an outage, and a stuck transaction is surfaced by how long it has been pending, not by moving it.
- **`BROADCAST → FAILED_RETRYABLE` exists but is unreachable from the send path.** Only reconciliation takes it, and only where the provider's pending nonce proves the assigned nonce is still unused. The first version of the table omitted the edge, which was too strong — a free nonce is a proof, and refusing to record it would strand provably-unsent rows in flight and block the queue forever.
- **A spent nonce with no hash stays `UNRESOLVED`.** The one case recovery cannot close: marking it failed invites a resend under a nonce that is gone, and marking it confirmed claims an outcome nobody read.
- **`CONFIGURE_ORGAN_THRESHOLDS` has no atomicity across its three calls.** A failure part-way leaves an organ genuinely part-configured, so the outcome is `PARTIALLY_SUBMITTED` rather than a refusal — "nothing happened" would be false.
- **Nothing broadcasts on a timer.** `submitOperation` is the only thing in the application that sends, and it is not wired to any trigger yet.

### 2026-09-06 — slice 2: receipt stamping

`ReceiptStamper` port, `PdfReceiptStamper`, `stampOperationReceipt`, and `OperationStore.formBytes` — which gives the bytes stored at import their first reader.

- **Stamped on confirmation, never on broadcast** (hard rule 5), and a **reverted transaction is stamped too**: it confirmed, and the receipt says `REVERTED`. Absence of a receipt means "outcome unknown", so refusing to stamp a revert would make that absence a lie.
- **No chain access at all, and no `Clock`.** The first version took one to read the confirming block's time — which would have made a receipt un-regenerable offline, contradicting the invariant the module itself quotes. The block timestamp is now read once with the receipt and stored on the attempt (`confirmed_at`), so a workstation clock has no route to the page.
- **Stamping is idempotent and byte-identical.** A receipt is a rendering of the stored form plus the transaction record; a lost file is regenerated with no chain write and no chain read.
- ~~**Fields are overwritten unconditionally and the form is flattened last.** Flattening destroys the fields, so any value set afterwards would silently vanish.~~ **Superseded on 2026-09-06 by slice 3** — the receipt is no longer fields, so the order reversed: flatten first, then stamp. The flattened result is still refused by this application's own ingestion as `FLATTENED`, which is what stops a receipt re-entering the pipeline.
- ~~**A new wording slot, `receipt.watermark`, is outstanding.**~~ **Withdrawn in slice 3**, which replaced the text watermark with a drawn stamp. Its rule survived into the stamp's own title slot: it must not say the proposal was accepted, because a confirmed transaction says nothing about whether a voting passed.

Receipt stamping hangs off confirmation, never off broadcast. A reverted transaction is stamped too. Regeneration from stored form bytes plus the transaction record must work without a chain write.

### 2026-09-06 — slice 3: the template reformation and the receipt stamp

Asked for directly: make the fields only the application fills non-editable — "better: labels or texts with special styling" — and replace the receipt fields with a drawn stamp, with everything rendered inside it. Reopens finished work in Phases 4 and 6 rather than adding to them.

- **`zarya.context.*` and `zarya.receipt.*` stopped being fields.** Context is printed on the page as `label   value` with a rule down the left margin; the receipt is a stamp. `templateFieldNames()` is now the three `zarya.meta.*` plus that operation's inputs and nothing else, so **every widget on an issued form is one a member is meant to write in** — the trust rule made visible instead of merely stated. It had been six shaded receipt boxes and up to four shaded context boxes that a member had to be told not to fill in.
- **`FORM_SCHEMA_VERSION` → `zarya.form.2`.** Every form issued under `.1` is uningestible and no migration or compatibility path was built, on the user's explicit instruction that the current database can be dropped. **This was affordable exactly once.** It stops being affordable the day the party holds printed forms.
- **`CONTEXT_TAMPERED` is gone, and its replacement is stronger.** The check compared a `zarya.context.*` field against the record and warned; there is nothing in the file to compare now, because page text is not something a form viewer can edit. A field from either retired namespace is refused as `RETIRED_FIELD` — named rather than folded into `UNKNOWN_FIELD`, since "this used to exist here" and "this never existed" are different facts about a document. The `warnings` channel stays and currently carries nothing, which is stated in its own doc comment rather than disguised.
- **The stamp overprints and no page is added** — specified. Its interior is an opaque ground so the six facts stay readable over whatever they cover; the frame lands on page content. **Flatten first, then stamp**, because pdf-lib appends flattened appearances and a stamp drawn earlier would sit under the values it stamps.
- **The mark is hard blue lines from `src/assets/receipt-stamp.svg`, paths only**, because `drawSvgPath` understands nothing else and would silently drop a `<rect>`. `stampStrokes()` refuses an asset containing one rather than losing it. The asset and the text share one coordinate table (`receiptStampArt.ts`); a test asserts the asset's rules sit exactly at the band edges the text is placed from.
- **Two wording slots are outstanding**, `stampTitle.document` and `stampNotice.disclaimer`, and four were withdrawn. The stamp currently prints bracketed placeholders for both, so **it is not shippable to a member yet.**
- **A new test technique.** Drawn text cannot be read back as text — pdf-lib writes glyph ids — so `testing/drawnText.ts` lays a string out in the embedded font and looks for that run of ids in the content stream. That is what now proves the organ label and all six facts are actually on the page; without it, a value that stopped being drawn would leave no field behind to miss it.

Owed downstream: **Phase 9's stamp trigger produces a drawn document rather than a filled one**, so the UI hands back a file that cannot be re-imported at all rather than one whose fields are populated.

### 2026-09-06 — slice 4: the chain adapters get tests

`PrivateKeySigner` and `ZaryaReceipts` had been listed as unverified in three consecutive worklogs. Taken before any UI wiring, because wiring a button to untested adapters is backwards.

- **The first test in the repository that sends a transaction**, against a local anvil forking Sepolia. Every other fork test says "nothing here signs or broadcasts" and still does; this one cannot, because nonce assignment and hash derivation are properties of a node's response. Nothing reaches Sepolia.
- **It proves the premise recovery rests on:** a reverting call throws at gas estimation *without consuming a nonce*, so `reconcileTransactions` treating a free nonce as proof that nothing landed is sound. That had never been checked against a node.
- **A secret was leaking, and the comment claiming otherwise is why.** `PrivateKeySigner` said `JSON.stringify(signer)` yielded `{}`; it yielded two kilobytes including the RPC URL with its API key. `private` is erased at runtime. Fixed at the root — `hideTransportUrl` makes `transport.url` non-enumerable at construction, covering all twelve classes that hold a client — and recorded in `INVARIANTS.md` under Secrets.
- **Still not wired.** `submitOperation` and `stampOperationReceipt` remain reachable from nothing. That stays a deliberate decision rather than a default.

## The remaining plan, rescoped 2026-09-06

Asked for directly, after an estimate of 13–18 slices. Three changes, and the reasoning matters more than the numbers because the first one is a **capability being dropped**, not a reordering.

**Wiring comes before building.** About nine thousand lines are currently reachable only from tests. Every defect this project has actually hit — the font subsetting that made three days of matrix reports unreadable, the hint descenders sliced by a field box, the worker never built for Node, the startup error present since Phase 1 — was found by running the application, never by the suite. Each phase stacked on unwired code compounds untested surface and makes the eventual defect more expensive to reach.

**The batch engine is cut down to bulk import.** It was the largest remaining phase and rests on an assumption nothing supports: that governance operations depend on one another. The contract has no such relation, and no requirement has ever named one. A dependency DAG, cycle detection, `WAITING_FOR_DEPENDENCY` and `WAITING_FOR_ONCHAIN_CONDITION` are therefore machinery for a case that has never been described. **If the party does describe one, this decision is wrong and the DAG comes back** — that is the condition to watch for, and it is cheaper to add later than to carry unused.

What survives the cut is everything that earns its keep without dependencies: validate every file before the first write, isolate an invalid item, allow `PARTIAL`, and resume after a crash.

**The UI is built plain and deliberately so.** Phase 9 carried most of the schedule risk, and the gap between "functional" and "designed" is several slices. Plain can be raised later cheaply; the reverse is not true.

Two smaller ones: replacement-by-fee ships as *surfaced and resolved by hand* — one wallet, low contention, and a fee bump is its own feature with its own tests. And most of Phase 10's end-to-end work stops being construction once the UI is wired incrementally; it becomes verification that was happening anyway.

Estimated **9–12 slices**, down from 13–18. What is explicitly **not** cut: the executor's two suppression states (the contract makes them mandatory), the hostile-PDF fixtures at the trust boundary, and the manual verification nobody has done.

## Phase 6 — remaining

**Slice 5: wire the write path.** `submitOperation` and `stampOperationReceipt` reach the UI. This is the first way the application can broadcast, so it is also where an explicit confirmation belongs — hard rule 1 says a transaction is never sent unasked, and a button is the asking.

#### 2026-09-06 — slice 5: the write path is wired — **done**

**The application can now broadcast.** A button, a confirmation in main, and a worker that signs.

- **The renderer names an operation and nothing else.** `submitOperation` carries one `operationRef` — no intent, no calldata, no address, no amount. The untrusted UI chooses *which* stored operation to send and has no way to influence *what* it is. A payload that could carry calldata would put a hole in the form pipeline's allow-list one layer below where anyone would look for it.
- **The intent is derived again, from the stored document.** Nothing persists an intent, so submission re-reads the bytes stored at import and rebuilds it through the same parser, binding and builder that accepted it. The transaction is therefore derived from what the member actually returned, and the numerical scale is read at submission rather than at import — one step closer to the mined block. `intentFromForm.ts` is shared by both paths so the subtle part cannot drift.
- **The confirmation lives in main**, as a modal defaulting to Cancel. It stops a mis-click. It is **not** a defence against a compromised renderer, which could invoke the channel with any reference and would see its own choice named back — that boundary is the narrow payload plus the worker's derivation, and the code says so rather than overclaiming.
- **The member wallet is generated, encrypted and stored once** — corrected the same day, after `ZARYA_MEMBER_KEY` was rejected as a design. `MemberKeyStore` and `SafeStorageKeyStore` create a key on first start, encrypt it with `safeStorage` and write it beside the database. Nothing is configured, so nothing can be misconfigured, and there is no plaintext key on disk to leak. `SecretConfig` holds no key material at all.
- **`safeStorage` is main-only**, confirmed in Electron's own typings — it appears in `namespace Main` and not in `namespace Utility` — so the worker cannot decrypt. Main sends the key over the message port at each worker start, not through the environment, which is inherited by child processes and readable from outside on several platforms.
- **The signer is built per request and never cached**, so the key is held in one module-local and nowhere else.
- **No backup exists**, and that is now a named open decision: the encryption is bound to the OS account, so a lost profile is an address that can never act again.
- **An unconfigured wallet is a refusal, not a failure.** The read, issue and import half works without one.

**Slice 6: stuck detection.** Surface a transaction that has been `PENDING` too long, with re-checking. Replacement-by-fee is deliberately **not** in it: same nonce, explicit fee bump, its own tests, and no evidence yet that Sepolia contention needs it.

## Phase 7 — executive reconciler

Discovery via the `VotingCreated` cursor; chain-time deadline checks; enqueue `executeVoting(votingId)` only. Startup, periodic, manual `Run now`, and reconnect all call one `reconcile()`.

Cheaper than it looks: `VotingDiscovery` and the persisted cursor already exist from Phases 2 and 5. What is missing is the job, its states, and the two suppressions the contract forces — `InsufficientVotes` is terminal forever, and an *approved* voting can be permanently unexecutable too. Without both, discovery re-offers a dead voting on every pass.

## Phase 8 — bulk import

**Rescoped from "batch engine" on 2026-09-06.** A batch is still a persisted object with a stable id, per-item records, and its own states — that is what makes resume possible and it is not a loop around a variable.

In: parse and validate every file before any write; per-item isolation so an invalid form does not block a valid one; duplicate and conflict detection through the three existing signals (file hash, `operationRef`, semantic identity); `PARTIAL` as a normal terminal state; resume and cancel; one receipt directory per batch.

Out, until a requirement asks for it: dependency edges, the DAG, cycle detection, and the two waiting states.

## Phase 9 — UI

Form template buttons; form import and review including any disclosure the parser raises; audit trail; privileged operation preview; executive status and `Run now`; error detail without secret exposure.

**Functional and plain.** No design system, no theming; legibility and correct labels only. The wording is the party's and is already centralized, so raising the finish later touches layout and not language.

Per-organ and per-voting eligibility thresholds **cannot be displayed** — no getter exists. Do not design UI that assumes they can.

## Phase 10 — hardening

Deterministic local E2E; eligibility snapshot regression; Chairman cross-organ tests; approval boundary and zero-vote tests; process-kill recovery; hostile-PDF fixtures; opt-in Sepolia smoke test; security review.

Smaller than it reads if Phase 9 is wired incrementally: the journeys become verification of paths a person has already walked, rather than the first time anything has been driven end to end.
