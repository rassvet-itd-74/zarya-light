# Phase 4 slice 1 — the field-name schema and the mapping onto domain keys

## Ask

"Proceed further." Phase 4, first slice: the field-name schema and `schemaVersion` in one module all
three form directions import. Taken deliberately without a PDF library, because the schema, the
trust split, and the mapping onto the intent builder are all decidable and testable without one —
and because Phase 3 slice 1 recorded "nothing has ever built an intent from a real form" as its
biggest unverified item. That is the gap this closes.

## Changes

**`formSchema.ts` — the names, the version, and the split.** Four namespaces, and they are trust
levels rather than tidiness: `zarya.meta.*` and `zarya.context.*` are app-authored, `zarya.input.*`
is the only namespace read for a value, and `zarya.receipt.*` is app-authored and empty until a
transaction confirms. The receipt fields are defined **now**, in the first slice that defines
anything, because retrofitting them later invalidates every form already handed out.

**The `zarya.input.*` suffix *is* the domain key.** `zarya.input.member` carries `member`, so the
mapping from the form vocabulary to the domain vocabulary is a prefix strip. The alternative — a
hand-maintained table — fails silently the first time a key is renamed on one side, and the two
vocabularies are allowed to coincide here precisely because that failure mode is worse than the
coupling.

**`FIELD_PLAN` is hard rule 4 written out per operation.** Which keys a human fills, which the app
recovers from the record it wrote at issuance. Two entries carry the weight:

- **`decimals` on a numerical value proposal is bound.** It is the scale the *cell* had when the
  template was issued, and the contract has no argument for it. A form permitted to state its own
  scale could submit a number a hundred times too small with nothing on chain to notice.
- **`votingId` on a vote is bound.** A tampered voting number in the file would move a vote onto a
  different proposal and the vote itself would succeed.

Three things the plan deliberately does *not* bind. `duration` is human-filled: the contract accepts
any value, `durationPolicy` bounds it as client policy, and semantic identity already excludes it —
proposing the same membership change for a day or a week is the same proposal, so nothing depends on
the app owning it. The coordinates are human-filled for the reason the matrix reference report
exists: it is the document a voter consults to learn which `(x, y)` to write, and a bound cell would
make the report pointless. And there is no `zarya.input.signer` at all — one wallet, one serialized
write queue, so a field for it would ask a member to choose something that cannot be honoured.

**`assembleFormInput.ts` — the structural half of ingestion.** A parsed form plus its operation
record to the `IntentInput` the builder takes, with eleven refusal codes and one warning. It is the
second narrow point in the pipeline and narrow differently from the first: `buildIntent` decides
whether a *value* is usable, this decides which values are even looked at.

The check order is part of the behavior. `schemaVersion` is read before anything else, because an
unrecognised version means the field names in the file mean something this build does not know, so
reading them would be the best-effort parsing `INVARIANTS.md` forbids — and the test asserts that an
otherwise hostile form still produces exactly one refusal. The re-import marker is next, so a stamped
form never reaches validation.

**Bound forms only.** No `operationRef` is a refusal rather than a generic blank form. An unbound
form would have to take the organ triple from the file, which is the one thing the bound half exists
to prevent, and `zarya-pdf-forms` says to support unbound forms only if the product requires it.
Nothing has asked.

**The tamper check compares and then ignores.** A `zarya.context.*` field that disagrees with the
record produces a warning, not a refusal: the value is not used, so refusing would give a tampered
display field power over an import. A context field the record has no expectation for produces
nothing at all — "unknown" and "disagrees" are different and only one is evidence.

## The test that makes the plan trustworthy

A plan listing the keys `buildIntent` reads is a second copy of that list, and a key the builder
reads and the plan omits is a form that can never be completed — reported to the member as *their*
validation error. So the test does not restate the keys. It **observes** them:

```ts
const probe = new Proxy(input, {
  get(target, property) {
    if (typeof property === 'string') seen.add(property);
    return Reflect.get(target, property) as unknown;
  },
}) as IntentInput;
buildIntent(operationType, probe);
```

`IntentInput` is a `Readonly<Record<string, string | undefined>>`, so a `Proxy` satisfies it and
every key the builder touches is recorded. The sweep asserts the plan provides all of them for all
eleven operations.

The organ triple needed care: `organNumber` is read only for a local organ and `regionSubjectCode`
only for a scoped one, so the plan lists all three and separate cases exercise a local organ and a
global one. Without them, listing three keys would be justified by nothing.

## The round trip, minus the PDF

`formRoundTrip.test.ts` fills a template's fields programmatically, runs intake, builds the intent,
and asserts it **equals the `INTENT_SAMPLES` fixture** the intent layer is already tested against —
for all eleven. The fixtures were built for this in the previous slice, which is why the values line
up. Three assertions inside it are the ones worth having:

- the form carries subject code `95` and the intent carries ordinal `20`, so a form that passed its
  number through would be visible rather than silently addressing Lugansk;
- `12.34` on the form against the record's two decimals becomes `1234n`, and `12.345` is refused
  rather than rounded;
- `FOR` maps to a direction and `yes`, `For`, `да`, `true` and `1` are all refused — no sentiment, no
  case folding, no near-miss.

It ends by running the whole deterministic pipeline — fields, intake, validation, dispatch — for all
eleven and asserting thirteen calls come out, none of them `executeVoting`.

## One test claimed more than it checked

A test called "lets a bound key win even if an input field carried it" asserted the refusal and then
asserted a bound value on an *unmodified* form, which does not demonstrate precedence at all. The
assembler does write bound keys after input keys, so the record would win if the field list were ever
wrong — but that second mechanism is not separately observable, because the first one refuses first
and a refused result exposes no input. Split into two honestly-named tests, with the unobservable
half stated in a comment rather than asserted.

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
 Test Files  47 passed (47)
      Tests  598 passed (598)

$ npm run ai:validate
AI package OK
```

Up from 44 files / 550 tests. New: `formSchema` (17), `assembleFormInput` (24), `formRoundTrip` (7).

## Unverified

- **No PDF has been read or written.** `ParsedFormFields` is a `Record<string, string>` a test builds
  by hand, so nothing here has met XFA, encryption, flattening, incremental updates, duplicate field
  names, an appearance stream disagreeing with `/V`, or a compression bomb. Every one of those is a
  refusal the *library* slice owes; the refusals implemented here are the ones that need only the
  field values.
- **`MISSING_INPUT_FIELD` stands in for the flattened-form check** and is not the same check. A
  flattened PDF loses its fields, so this fires — but detecting flattening properly means asking the
  library whether an AcroForm exists at all, which is a better message and a different code.
- **The bound/input split is a product judgement in four places.** `duration`, the coordinates,
  `valueAuthor`, and the organ. Each is argued in `formSchema.ts` and none was confirmed against a
  stated requirement; a product decision that a member may not choose a duration would move it.
- **No template has been issued**, so `templateFieldNames` describes a document that does not exist,
  and `operationRef` is a string a fixture invents rather than something persisted before a file is
  emitted. That ordering — record first, file second — is Phase 5's to enforce.
- **The context tamper check has no real expected values.** `IssuedOperation.context` is supplied by
  the caller, and what issuance will actually store there is not settled. If issuance renders a
  display value differently from how the check composes it, every import warns.
- **Nothing is wired to the worker, IPC, or the renderer.** No application service calls any of this
  yet. `npm start` was not run; worker protocol stays at v2.
