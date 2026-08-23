# Wire brand assets and design receipt stamping

## Ask

After a transaction is sent, produce the filled PDF back with a watermark showing it was sent plus the transaction hash and the Zarya logo. Use the favicon too; move both out of `src/` if needed. Refined mid-slice: the watermark can be an AcroForm field the user does not fill, overwritten with the valid value if they do.

## Changes

**Assets.** Both moved to `src/assets/`, each format routed where it is actually supported: `logo.png` for the Electron window icon (`nativeImage` takes PNG/JPEG data URLs, not ICO) and for PDF embedding; `favicon.ico` for the HTML favicon, `packagerConfig.icon`, and Squirrel `setupIcon`. Used `?inline` for the window icon so the PNG becomes a build-time data URL — no runtime path lookup, so dev and packaged asar behave identically.

ESLint needed `import/no-unresolved` to ignore Vite query suffixes; used the rule's documented `ignore` option rather than a disable comment. A first attempt put the rationale in a `comment` key, which the rule's schema rejects (`additionalProperties: false`) — moved it to a `//` comment, which ESLint strips from `.eslintrc.json`.

**Receipts.** The field-based watermark needs no new trust machinery: `zarya.receipt.*` sits in the app-authored namespace, so the existing rule already covers it and ingestion never reads those fields for value. Someone typing a plausible transaction hash there achieves nothing. At stamp time the app overwrites every receipt field unconditionally.

It also yields re-import safety twice over: a populated `zarya.receipt.txHash` on an *incoming* form is the rejection marker, and flattening the receipt means the existing flattened-form check catches it independently. `zarya-testing` requires proving each mechanism separately.

Two design calls the request did not settle:

- **Stamp on confirmation, not broadcast.** The ask said "at the end of transaction sendings", but a broadcast transaction can revert, be replaced, or be dropped. A form watermarked "sent" at broadcast time is a record that may become false after someone printed and filed it. Stamping now hangs off confirmation with an explicit `status`; a reverted transaction is still stamped as `REVERTED`; absence of a receipt means *unknown*, never *failed*.
- **A confirmed transaction is not an accepted proposal.** For `castVote`, success means the vote was recorded. For `executeVoting`, success means the call did not revert — and with rejection semantics unresolved the governance outcome may not be readable. Receipts keep those as two separate statements.

Also recorded: a watermark is not a security control (anyone can add one to any PDF), and a receipt is a *rendering* of stored data, regenerable without a chain write, so the PDF is disposable output rather than state.

## Evidence

```text
npm run ai:validate → AI package OK — 13 skills, 27 documents, 2136 lines, 70 ABI symbols cross-checked
npm run typecheck   → exit 0
npm run lint        → exit 0
```

Typecheck alone cannot prove Vite inlines the PNG, and the app cannot launch, so verified with a throwaway Vite build: output contained `data:image/png;base64,` with no `logo.png` path reference.

`USE_CASES.md` shifted labels again; now A–J, verified unique. `CLAUDE.md` at 50 lines, 8 rules, still exactly one `IMPORTANT`.

## Unverified

Nothing was verified against a running application — the Electron binary is still absent. The window icon, HTML favicon, and installer icons are wired correctly by inspection and by the inline-build check, but have not been seen rendering.

Receipt stamping is documented, not implemented; there is no PDF library and no transaction queue to hang it off.

## Follow-ups

- `logo.png` is 120×120, landing near 76 DPI at print-watermark size — a larger or vector source is worth requesting before this reaches users who print.
- `favicon.ico` has only a 32×32 entry, so Windows large-icon renderings upscale; no `.icns`/`.png` exist, so macOS and Linux packaging falls back to the default Electron icon.
- AcroForm field rotation is quantized to 90° steps, so a field-based watermark is a horizontal band. A diagonal stamp would require drawn page content.
