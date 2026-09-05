# Phase 6 slice 2 — receipt stamping

## Ask

*"Move on"* — continue Phase 6. Slice 2 is receipt stamping, which is also what finally gives the
form bytes stored at import a reader.

## Changes

**`domain/ports/ReceiptStamper.ts`** and **`adapters/forms/stampReceipt.ts`** — fill the six
`zarya.receipt.*` fields from the transaction record, draw the watermark on every page, flatten.
In that order: flattening destroys the fields, so a value set afterwards would silently vanish, and a
watermark drawn afterwards would sit under nothing.

**`app/stampOperationReceipt.ts`** — refuses anything not `CONFIRMED`, refuses an attempt belonging
to another operation, and writes through `FileSink`.

**`OperationStore.formBytes`** — a separate read from `find`, because these are hundreds of kilobytes
and the only caller is stamping; a listing carrying them would make reconciliation expensive for
nothing.

**`receipt.watermark`** is a new wording slot, added to `wording.ru.txt` for the party. It must not
say the proposal was accepted — a confirmed transaction says nothing about whether a voting passed,
and that would be the most consequential mislabel in the application.

## Decisions

**A reverted transaction is stamped.** It confirmed; the receipt says `REVERTED`. Absence of a
receipt means "outcome unknown", so refusing to stamp a revert would turn that absence into a lie
about something that definitely happened.

**No `Clock`, and the compiler is what found it.** The first version took one to read the confirming
block's timestamp — which would have meant a receipt could not be regenerated offline, contradicting
the invariant the module's own doc comment quotes. `TransactionOutcome` now carries `confirmedAt`,
read once with the receipt and stored on the attempt as `confirmed_at`. A workstation clock has no
route to a receipt at all, and stamping needs no chain access.

**`confirmed_at` went into migration 3 rather than a migration 4.** Version 3 was written earlier in
this same uncommitted session and has never run anywhere, so no database in the field has seen it.
The append-only rule protects shipped versions; this one is not shipped. Worth naming because the
rule's whole point is that it is not negotiated case by case.

**The suite now asserts a named outstanding slot** rather than an empty list. `pendingLabels()`
returning `['receipt.watermark']` is the mechanism working — it reports what the party owes — and
naming the exact list means a *different* unworded slot still fails.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  73 passed (73)
      Tests  975 passed (975)      # was 969
```

Six tests in `receiptStamping.test.ts`, built from a **real** issued template through the real
issuer, a real filled form through `recordReturn`, and real transaction rows:

- every receipt field filled, and the result refused by this application's own ingestion — as
  `FLATTENED`, since pdf-lib's `flatten()` leaves an empty AcroForm rather than removing it. I had
  expected `NOT_A_FORM`; either refusal keeps a receipt out of the pipeline and this one describes
  the file more accurately.
- a `PENDING` attempt refused as `NOT_CONFIRMED`.
- a reverted attempt stamped, with `status: REVERTED`.
- **stamped twice, byte-identical** — and the dependency list contains no chain reader and no clock,
  so that property is structural rather than observed.
- an attempt from another operation refused.
- the fields written are exactly `RECEIPT_FIELDS`, compared against the schema rather than a literal.

## Unverified

- **No receipt has ever been looked at.** Not rendered, not opened. The watermark's placement,
  opacity and rotation are unexamined, and the last time a document went unlooked-at in this project
  it had been unreadable for three days.
- **The watermark is unworded**, so it currently draws the bracketed placeholder `[receipt.watermark]`
  across every page. That is the designed fallback, not a bug, but it means the current output is not
  shippable to a member.
- **Nothing calls `stampOperationReceipt`.** No trigger, no channel, no button — the same unwired
  condition as `submitOperation`.
- **Nothing has been broadcast on any network**, so no receipt has ever been stamped from a real
  transaction. Every test builds its transaction rows by hand.
- **The viem adapters remain untested**, now including `blockTime`.
- **A form flattened by this stamper has not been checked in a viewer** — whether the field values
  survive flattening visibly, with the embedded font, is exactly the class of thing that needs a
  human eye and has not had one.
