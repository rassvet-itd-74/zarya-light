# Phase 6 slice 3 — the template reformation and the receipt stamp

## Ask

Two changes, given as a written implementation task:

1. Fields the application fills should not look editable — *"better: labels or texts with special
   styling."*
2. The receipt fields should be deleted and a drawn SVG stamp put in their place, with **all six
   facts rendered inside the stamp**. Hard blue lines. A dummy mark for now, to be looked at.

Answered mid-slice when asked: everything already issued and the current database can be dropped, no
backward compatibility; and the stamp **overprints** — no page added, no space reserved.

This reopens finished work in Phase 4 and rewrites Phase 6 slice 2, which was completed the same day.

## Changes

**`formSchema.ts`** — `templateFieldNames()` is now the three `zarya.meta.*` plus that operation's
`zarya.input.*`. `FORM_SCHEMA_VERSION` → `zarya.form.2`. `CONTEXT_FIELDS` and `RECEIPT_FIELDS`
survive as names, not fields: the first still keys `TemplateRequest.context`, the second names what a
stamp states, and `isRetiredNamespace()` lets a returned file carrying either be refused by name.

**`issueTemplate.ts`** — `contextLine()` replaces four shaded read-only boxes with `label   value` on
one line and a rule down the left margin. The receipt block is gone entirely. `fieldBox` lost its
`readOnly` parameter because nothing passes `true` any more.

**`receiptStampArt.ts`** (new) — the stamp's bands, columns, sizes and baseline offsets, plus
`stampStrokes()`, which reads `d` and `stroke-width` off the asset and **throws** on `<rect>`,
`<text>` and the rest. `drawSvgPath` cannot draw them and would drop them silently.

**`src/assets/receipt-stamp.svg`** (new) — 340 × 170pt, thirteen paths, no fills.

**`stampReceipt.ts`** — rewritten. Flatten, opaque ground, strokes, then the six facts as text.

**`assembleFormInput.ts`** — `RETIRED_FIELD` replaces `RECEIPT_ALREADY_STAMPED`; `compareContext()`
and `CONTEXT_TAMPERED` deleted.

**`testing/drawnText.ts`** (new) — `drawnContent()` and `asGlyphs()`, for asserting that something
was drawn.

Wording: `receipt.*` relocated into the stamp at 6.5pt in a half band; `stampTitle.document` and
`stampNotice.disclaimer` added; `receipt.watermark`, `section.receipt`, `sentence.receiptNotice` and
`sentence.tamperNotice` withdrawn. 98 slots, 96 worded.

## Decisions

**The rule is now visible instead of stated.** Hard rule 4 has always been "read only the human-filled
fields". A member could not see that: the page was boxes, some theirs and some not, distinguished by
shading and by a ReadOnly flag that `zarya-pdf-forms` itself calls advisory. Every widget on an issued
form is now one they are meant to write in, and the trust boundary is a thing you can point at on
paper.

**Deleting `CONTEXT_TAMPERED` made the check stronger, not weaker.** It compared a context field to
the record and warned; the import proceeded. There is no field now, so a file that disagrees about
its organ is one that has had a field added to it — refused, not imported with a note attached. What
was lost is real and small: a member who edited a display value used to be told so.

**The `warnings` channel is kept and currently carries nothing.** The port declares it and the UI
renders it. Its doc comment says plainly that nothing produces one, rather than leaving a closed
union of codes that no longer occur.

**Flatten first, then stamp** — the reverse of slice 2. pdf-lib appends flattened field appearances to
the content stream, so a stamp drawn first would end up underneath the values it stamps. "Applied on
top" has to mean last.

**An opaque ground inside an overprinting stamp.** Overprinting was specified; unreadable facts were
not acceptable, since the transaction hash is the one value a member can check against a block
explorer. The frame overprints, the interior covers. What it covers is genuinely hidden — that is the
cost, paid deliberately.

**The schema bump has no migration and never can again.** Nothing is in circulation, so `.1` forms
were made uningestible outright. The same change with forms in the field would need a dual-read path
or a reissue campaign.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  74 passed (74)
      Tests  990 passed (990)      # was 975

$ npm run wording:check
96 of 98 slots worded.
still outstanding (2): stampTitle.document, stampNotice.disclaimer
```

New in `receiptStamp.test.ts`, all measured in the embedded font at the drawn size:

- the hash fits its band — and so does the widest hash that exists, `0x` followed by 64 `f`, which is
  a different measurement and was not assumed equal;
- `STAMP.type.hash >= 7.5`, asserted so that shrinking the type to fit something else fails here
  rather than on paper;
- the asset's five band rules sit at exactly the five band edges the text is placed from, and the
  column split at exactly the right column's start;
- an asset with a `<rect>` added throws, naming the element.

`drawnText.ts` is what proves anything is drawn: the organ label and the contract address on an issued
template, and the hash, signer, block, status and chain time on a stamped receipt — each found as its
glyph run in the content stream. The signer had to be read back from the store to assert on, because
glyph ids are case-sensitive and the address is normalised on the way in; the first version of that
assertion failed for exactly that reason.

`assembleFormInput.test.ts` gained the refusal both ways round: a receipt field is refused **filled or
empty**, and an unknown name is still `UNKNOWN_FIELD` rather than `RETIRED_FIELD`.

## Unverified

- **No receipt has been looked at, and no form either.** This is the third slice in a row to say so,
  and it now covers more: the context block's new styling, the stamp's placement, whether the opaque
  ground reads as a stamp or as a white box, and whether hard blue at 8pt over an A4 page is legible
  in print. Everything above is measured, and measurement has never been what found the defects in
  this project — rendering has.
- **The stamp prints `[transaction record]` and `[This mark is not proof…]`** until the party words
  two slots. Designed fallback, but the current output is not shippable to a member.
- **Nothing calls `stampOperationReceipt`**, unchanged from slice 2. No trigger, no button.
- **Nothing has been broadcast on any network.** Every test builds its transaction rows by hand.
- **The overprint has never overprinted anything.** Test forms are short, so the stamp has always
  landed on blank paper in the bottom right. Whether it covers something a member wrote — and how bad
  that looks — is exactly what a real filled form would show and no test can.
- **`stampStrokes()` is a regex, not an SVG parser.** It refuses what it knows it cannot draw, which
  is not the same as refusing everything it cannot draw. A path using a command `drawSvgPath` mishandles
  would pass through it.
- **The viem adapters remain untested.**
