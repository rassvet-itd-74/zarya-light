# The numerical value schema — a third field category, and the eleventh operation becomes issuable

## Ask

Picking up from the issuance slice, which left three candidates. Asked which to take, the user chose
an order: *"Fix numerical value schema, then matrix report button, then import."* This is the first
of those three.

The problem was recorded twice in the previous slice: `CREATE_NUMERICAL_VALUE_VOTING` could not be
issued at all, ten of eleven worked, and which way to fix it was a product decision rather than a
coding one. So the slice began with the decision, not with code.

## The decision, and the two options not taken

`FIELD_PLAN` contained two claims that could not both hold. `decimals` on a numerical value proposal
was **bound** — *"the scale the cell had when the template was issued"* — while that same operation's
`x` and `y` were **member-filled**, on the grounds that *"a bound cell would make the matrix
reference report pointless."* At issuance there is therefore no cell, so there is no scale to record.

What makes it matter rather than merely being untidy: `addValue` takes only the scaled integer. There
is **no decimals argument**, so a wrong scale is a valid transaction storing a number off by a power
of ten, and nothing on chain can notice.

Three ways out were put to the user with that mechanic stated. The chosen one:

**`decimals` becomes neither bound nor member-filled.** It is read from the cell at import, for the
coordinate the member actually wrote — `numericalCell(at).decimals`.

The other two, and why they lose:

- **Bind `x` and `y` at issuance.** Coherent, and it keeps `decimals` app-authored exactly as hard
  rule 4 describes: consult the report, then request a form for that cell. But it moves the
  coordinate out of the member's hands for one operation out of eleven, and a scale recorded at
  issuance can still go stale while the form is out — so the staleness is *detected* rather than
  *prevented*.
- **Let the member type the scale.** One line. It also puts the magnitude of a governance value in
  the returned file, which is what hard rule 4 forbids, and because the contract has no argument for
  the scale the client's comparison would be the only defence — load-bearing rather than advisory,
  against hard rule 6.

The chosen option is **stronger than binding, not a concession**. `12.34` means
twelve-point-three-four at whatever precision the cell holds when the form comes back. The
"hundred times too small" failure the old comment warned about cannot occur, because the scale that
produced the integer is never older than the import.

Costs, stated rather than discovered later: ingestion of a numerical value form now needs a chain
read, so an RPC outage becomes an import refusal for that one operation; and `assembleFormInput`'s
output map is deliberately incomplete.

## Changes

- **`FieldPlan` gains `resolved`** beside `input` and `bound`, with all eleven entries updated.
  `CREATE_NUMERICAL_VALUE_VOTING` is the only non-empty one.
- **`resolvedKeysFor(operationType)`** — the accessor ingestion iterates, mirroring the existing
  `contextFieldsFor`. Empty for ten of eleven, which is precisely why the import use case must
  iterate the schema instead of special-casing the eleventh.
- **`KNOWN_AT_ISSUANCE` / `unavailableBoundKeys` kept, now empty for all eleven.** The mechanism
  fired once, for real, and that is the argument for keeping it — see below.
- **Five doc comments corrected**, one of which was making a false claim about behavior.
- **`formSamples.ts` gains `RESOLVED_VALUES` and `resolvedValues()`**, kept as a separate table from
  `BOUND_VALUES` on purpose: the whole point of the category is that its provenance differs, and a
  fixture that merged them would let a regression through — drop the resolution step and the value
  would still be found.

No production module changed behavior except the schema table itself. No new dependency.

## The false comment is worth naming

`buildIntent`'s `numericalValue` said the scale *"travels into the intent so preflight can compare it
against the cell's decimals now."* It does not. `numericalValueWarnings` reads the cell's binding,
theme and statement and **never looks at `decimals`** — the comparison was aspirational and had been
read as done. `intent.ts` said the same thing more plainly: *"Preflight compares this against the
cell's current decimals."*

Both now say what is true: the field records which precision produced `value`, so that a
submission-time check *can* compare it, and **no such check exists**. The note tells a reader not to
take the field's presence as evidence the comparison happens.

## What I deliberately did not build

A preflight scale check was the obvious next thing and I left it out. It would have had **no caller**
— `applicationPreflight` is reachable only from tests, and no submission path exists — and
unreachable machinery is exactly what the vertical-slice pivot was reacting against. The residual
window is written down in three places instead, so Phase 6 inherits it rather than rediscovering it.

Where the window is: import → mined. A decimals voting executing in that gap leaves the submitted
integer scaled by the old precision. Import and preflight happen moments apart, so this is not the
long staleness the old design had — but a form imported into a queue that then stalls is a real case,
not a hypothetical.

## Why the empty guard stays

`unavailableBoundKeys` now returns nothing for every operation, which looks like dead code and is
not. It is the mechanism that turned this contradiction into a refusal a user could read instead of a
scale invented by whichever code path reached it first. That is a thing that happened, not a thing
imagined.

What changed is where the invariant is *asserted*. `formSchema.test.ts` now checks directly that
every key in every plan's `bound` has an issuance-time source, so the next bound key added without
one fails the suite rather than one operation type in the running app. The runtime filter is the
second mechanism and does not depend on the first being correct.

I also deleted a test I had just written. It asserted the filter's behavior by reimplementing the
filter, which proves nothing; the schema invariant covers it honestly.

## Tests

880 → 885, and the four that carry the argument are in `issuanceRoundTrip.test.ts`, through the real
use case and a real SQLite database rather than fixtures:

- **It issues**, where it previously refused with `BOUND_VALUE_UNAVAILABLE`.
- **The row records the organ and no scale.** The negative matters as much as the positive: a
  `decimals` in `boundValues` would mean issuance had invented one, which is the failure the refusal
  existed to prevent and which a default would have quietly reinstated.
- **The document carries no scale field either** — not as `zarya.input.decimals`, not as
  `zarya.context.decimals` — while `zarya.input.x` and `y` *are* present, which is the half of the
  contradiction that survived.
- **The same filled form yields `1234n` at two decimals and `123400n` at four**, and fails to build
  at all if the resolution step is skipped. That last assertion is the point: it is the same number
  at both scales, which is the property reading the scale at import buys, and the failure mode of
  forgetting the merge is pinned so a caller hits it in a test rather than in front of a member.

In `formRoundTrip.test.ts`, a provenance test asserts from both sides that nothing a member could
edit and nothing issuance stored carries the scale — so the only place it can come from is the chain
read.

Six existing tests were updated, and one of them changed subject rather than wording:
`assembleFormInput`'s "a record that cannot complete the form" dropped `decimals` to trigger
`MISSING_BOUND_VALUE`, and now drops `organType`. That is a better test than it was — the organ is
the case where the form carries only a display copy, so there is genuinely nowhere else to recover it
from.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  64 passed (64)
      Tests  885 passed (885)   # the 885th is the hint-descender test, added last

$ npx vitest run src/app/issuanceRoundTrip.test.ts
 Tests  9 passed (9)          # was 5
```

`ai:validate` reports 16 skills, 57 documents, 71 ABI and 1706 source symbols cross-checked.

One failure during the work was mine and is worth recording because it is a trap this repo has hit
before: I added `JSON.stringify(built)` to two assertion messages and both tests died with *"Do not
know how to serialize a BigInt"*. An intent holds bigints. `formSchema.test.ts` already carried a
comment about exactly this, which I had read.

## Then it was issued from the running app

The claim of this slice is "the eleventh operation can now be issued", and a use-case test is not
where that gets settled — the previous slice exists because of what running the app found. So it was
run: `npm start`, the operation picked from the dropdown, an organ chosen, a path chosen in the save
dialog.

The database before, at `%APPDATA%/zarya-light/zarya.db` — **six** rows, and no numerical value among
them, which is what being unissuable looks like from the outside:

```text
CREATE_MEMBERSHIP_VOTING             EMITTED  {organType:LocalSoviet, regionSubjectCode:15, organNumber:0}
CREATE_MEMBERSHIP_REVOCATION_VOTING  EMITTED  {organType:LocalSoviet, regionSubjectCode:15, organNumber:0}
TRANSFER_CHAIRMANSHIP                EMITTED  {}
CREATE_CATEGORY_VOTING               EMITTED  {organType:LocalSoviet, regionSubjectCode:13, organNumber:0}
CREATE_CATEGORICAL_VALUE_VOTING      EMITTED  {organType:RegionalConference, regionSubjectCode:15}
CREATE_DECIMALS_VOTING               EMITTED  {organType:LocalSoviet, regionSubjectCode:95, organNumber:14}
```

The seventh row, after:

```text
operation_ref      zar-a6c37304-fb51-4aff-ad57-e28be35c3129
operation_type     CREATE_NUMERICAL_VALUE_VOTING
state              EMITTED
bound_values       {"organType":"LocalSoviet","regionSubjectCode":"13","organNumber":"12"}
displayed_context  {"zarya.context.chainId":"11155111",
                    "zarya.context.contract":"<the configured address, per DEPLOYMENT.md>",
                    "zarya.context.organ":"13.12.СОВ"}
```

What each part of that settles:

- **`EMITTED`, not `RECORDED`.** The state advances only after the file is written, so this is a real
  PDF on the user's disk and not a row that got as far as composing one.
- **`bound_values` carries the organ triple and no `decimals`.** This is the assertion the whole
  slice turns on, made by the application rather than by a test: nothing invented a scale to fill the
  gap the old schema left. Subject code `13`, never the ordinal.
- **`13.12.СОВ` came from Sepolia.** `resolve()` verifies the contract's rendering against the local
  mirror and throws on disagreement, and a throw becomes a refusal that never reaches `EMITTED`.
- **A real `zar-<uuid>`** from `CryptoIdGenerator`, meeting the primary key.

Also worth recording: the launch was clean. `[main] worker started (initial)` once, no restart loop,
and **no `Render frame was disposed`** — the two failures the previous slice fixed have stayed fixed
across a schema change and a rebuild.

The `operations` table has no path column, deliberately — where a save dialog put the file is not
governance state — so the document itself was checked by opening it. That found the next two things.

## The document was opened, and it was drawing over its own hints

Rendered through Chromium's PDF viewer (Electron's, driven headless) rather than trusted. Two results,
one good and one a defect.

**The Cyrillic renders.** Title, headings, labels, hints and the organ `13.12.СОВ` all draw correctly
in a viewer, which is the standing Phase 4 question and the reason PT Sans is embedded whole rather
than subset. The field set matched the row exactly: `zarya.input.x` and `y` present, `value`,
`valueAuthor`, `duration`, six empty receipt fields — and **no `decimals` field anywhere**, neither
input nor context. `zarya.meta.operationRef` matched the database row, so document and record are
provably the same operation.

Worth noting: the value hint already reads «число с точностью, заданной для ячейки» — *a number at
the precision set for the cell*. That describes the resolve-at-import model more accurately than the
bound design it was written for.

**The defect: every hint was being painted over by the field box beneath it.** In `textRow`,
`hintGap` was spent *above* the hint baseline, so nothing separated the baseline from the box:

```text
advance(TYPE.hint + ROW.hintGap)   // cursor -> hint baseline
text(hint, { y: cursor.y })
advance(ROW.fieldHeight)           // cursor -> box bottom
fieldBox({ y: cursor.y })          // box occupies [baseline-16, baseline]
```

A pdf-lib rectangle is placed by its lower-left corner, so the box's **top edge landed exactly on the
hint's baseline** and swallowed every descender. Unhinted fields escaped because `labelGap` gave them
2pt. Nine hint slots across most of the eleven operations, so every form this application has ever
issued carried it.

`rowHeight()` was **not** wrong — the row reserved the right total. Only the distribution inside the
row was, which is why no existing test saw it: the boxes were inside the printable area, no two
boxes overlapped, and the page count was right. The overlap was between a box and *drawn text*, and
nothing asserted anything about that.

Fixed with `ROW.hintDrop`, applied *after* the baseline and added to `rowHeight`. The size is not a
guess: measured from the embedded font, PT Sans descends **2.07pt** at 7.5pt type. My first estimate
was ~1.6pt, which would have made moving the existing 1.5pt gap look sufficient when it is not — so
the test asserts against the font's own metrics rather than a chosen number, and fails if the
clearance shrinks or the hint type grows.

Re-rendered after the fix: all four hints on the numerical form fully legible, still one page.
`fits on one page for every operation` passing is what covers the 2.5pt per hinted row.

## A sentence the application does not honour

Printed on every form with an `x` or `y` (`SENTENCES.coordinateDisclosure`):

> «Координаты должны соответствовать тем, которые были указаны в отчёте Зари, **и сверяются с ним при
> загрузке файла формы обратно**.»

*…and are checked against it when the form file is loaded back.* **Nothing checks that.** Import is
not wired at all, and when it is, what it will read is the cell from chain — not the report. Left
unchanged deliberately: this is the party's own wording, and softening a sentence on a governance
document is a decision for whoever owns it, not a tidy-up. Recorded here so it is not mistaken for
implemented behavior.

## Unverified

- **No member has typed into one.** The document renders correctly in a viewer, which is half the
  Phase 4 question; the other half is what happens when a field is *filled* — whether the viewer
  regenerates the appearance from the embedded font, which is the case PT Sans is embedded whole for.
  Reading a blank form does not exercise that.
- **Only Chromium's viewer was used.** Acrobat is the one that matters for members and it was not
  tried. The two disagree about appearance regeneration more than about glyphs.
- **The hint fix was verified on one form.** The numerical value template was re-rendered and its
  four hints are clean. The other eight hint slots — `quorum`, `approvalPercentage`,
  `approvalPercentageBase`, `categoryName`, `decimals` — are covered by the same constant and the
  same code path, and by `fits on one page`, but were not looked at.
- **Nothing reads `numericalCell().decimals` yet.** The port and the method exist and the schema now
  says to use them, but the caller is the import use case, which is slice 3 of the order the user
  set. Until then `resolved` is a category with a reader in tests only, and `resolvedValues()` stands
  in for the chain.
- **No check compares `intent.decimals` against the cell.** Deliberate, argued above, and the
  residual import → mined window stays open. It belongs with the submission path in Phase 6.
- **The 0-decimal cell case is untested against a real cell.** `parseFixedPoint` rejects a fraction
  longer than the scale and has its own tests, so `12.34` against a whole-number cell refuses — but
  that path has never run with a scale that came from chain rather than from a fixture.
- **Whether a member can find a cell's precision.** The scale is no longer printed on the form and
  never was. The matrix reference report publishes it per cell, which is the intended answer, and
  that report has no button yet — the next slice in the order.
