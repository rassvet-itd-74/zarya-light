# Migrate document intake from DOCX to app-issued PDF AcroForms

## Ask

Use PDF AcroForms instead of DOCX. Templates are prepared by the project, pre-fitted to their sources, and distributed through buttons in the app UI. Also audit the `__ai` folder against Anthropic best practices and fix what does not comply.

## Changes

Not a rename. The app issuing its own templates **inverts the trust model**, and that is where the risk moved.

With an unknown third-party format you distrust everything by default. With a format you issue yourself the tempting mistake is the opposite — *we wrote those fields, so we can trust them back*. You cannot: every field value, field name, and the ReadOnly flag are editable by whoever holds the file.

The rule that resolves it, now load-bearing across the package: read only human-filled `zarya.input.*` fields; recover app-authored values from local storage via `operationRef`; compare the file's copies to *detect* tampering, never to obtain a value. A tampered `votingId` then cannot influence a transaction because no code path reads that field for its value. It became hard rule 4 in `CLAUDE.md` — the single `IMPORTANT` — and the first question in `zarya-security` and `zarya-review`.

New `zarya-pdf-forms` skill replaces `zarya-docx-ingestion`, covering issuance and ingestion together because they share the field schema and a change to one is a change to the other. It carries the three-namespace schema, the bound/unbound distinction, and hazards DOCX vocabulary did not cover: **XFA shadowing AcroForm values** (reject, never reconcile), flattened forms, incremental-update revisions, and appearance streams disagreeing with `/V`.

Two knock-on corrections: `IMPLEMENTATION_ORDER.md` no longer has a blocked phase, and its "chain reads first" ordering is now justified by template pre-fill depending on those reads rather than by the format being unknown. `zarya-repo-bootstrap` and `__ai/README.md` both asserted "the document side has no spec", which became false.

**Best-practices audit** found three real gaps, all fixed: `CLAUDE.md` carried self-evident content the guidance says to cut (replaced with a Gotchas section — non-obvious behaviors are what belongs); emphasis was diluted across many lines (now exactly one `IMPORTANT`); and `ROUTER.md` duplicated skill selection that `description` fields already handle. One deliberate deviation: guidance shows supporting files inside each skill directory, but these references are shared by all 13 skills, so per-skill copies would reintroduce the duplication just removed.

## Evidence

```text
npm run ai:validate → AI package OK — 13 skills, 27 documents, 1982 lines, 70 ABI symbols cross-checked
npm run typecheck   → exit 0
npm run lint        → exit 0
```

Added a validator check that fails on any reappearance of DOCX vocabulary, since it carries security assumptions (ZIP bombs, macros, zip-slip) that do not apply to PDF and would quietly mislead. Verified firing on `DOCX`, `.docx`, and a stale `zarya-docx-ingestion` path reference.

`USE_CASES.md` gained an issuance section, which shifted every later section label; renumbered A–I and verified labels unique.

## Unverified

The field schema is a design proposal, not a specification from the requester. The `zarya.meta` / `zarya.context` / `zarya.input` split is what makes the trust rule enforceable, but the specific field names and whether unbound forms are wanted at all are open product questions.

No PDF library is chosen, so none of the PDF-specific hazard handling has been tested against a real parser.
