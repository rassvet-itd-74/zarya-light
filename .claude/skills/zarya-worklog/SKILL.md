---
name: zarya-worklog
description: Record each slice of work in the Zarya engineering log — what was asked, what changed, the evidence it works, and what stayed unverified. Use at the end of every coherent slice of work, and when promoting a decision into the binding references. Entries live in __ai/worklog/.
---

# Zarya worklog

Every coherent slice of work gets an entry in `__ai/worklog/`. Not every keystroke — a slice is the unit you would describe in one sentence to a colleague and that ends with checks run.

## Location and naming

```text
__ai/worklog/YYYY-MM-DD-short-slug.md
```

The date is the day the work happened. Slug is kebab-case and specific: `pdf-receipt-stamping`, not `updates`.

## Required shape

Four headings, all mandatory. `npm run ai:validate` fails an entry missing any of them.

```markdown
# <one-line title>

## Ask
What was requested, in the requester's terms. If the request changed mid-slice, say so and why.

## Changes
What actually changed and why it was the right change. Reference files by path.
Not a diff — git already has that. This is the reasoning a diff cannot carry.

## Evidence
The exact commands run and their results. Paste what the checks printed.
If a check could not run, say which and why.

## Unverified
What remains unproven, and what would prove it. Say "nothing" only when it is true.
```

Optional: `## Decisions` for choices made and alternatives rejected, `## Follow-ups` for work deliberately deferred.

## Rules

**Write it as part of the slice, not later.** A log written from memory at the end of a session loses the reasoning, which is the only part worth keeping.

**Evidence means output, not assertion.** "Tests pass" is not evidence. The command and what it printed is evidence. This mirrors the reporting rule in `CLAUDE.md`.

**`Unverified` is the most valuable section.** It is where the next person learns what to distrust. Forcing the question is the point; an honest "the app cannot launch, so this was checked by typecheck only" is worth more than silence.

**Append-only.** Do not rewrite an entry to reflect what you later learned. Write a new entry and reference the old one. The log is a record of what was believed when, which is what makes it useful for tracing a mistake.

**Do not duplicate git.** No file listings for their own sake, no restating the diff. Why, what was proven, what was not.

**Never log secrets.** No private keys, seed phrases, mnemonics, raw signed transactions, or RPC URLs containing credentials. A transaction hash and a signer address are fine; anything that could reconstruct a key is not.

## Promotion

The worklog is narrative — what happened. It is not where rules live.

When a slice produces a decision that binds future work, promote it:

- a settled product or architecture choice goes to `__ai/references/DECISIONS.md`
- a rule that must always hold goes to `__ai/references/INVARIANTS.md`
- a contract fact goes to `__ai/references/CONTRACT.md`
- an open question with the evidence that would close it goes to `__ai/references/DOCUMENTATION_STATUS.md`

Then reference the worklog entry from nowhere — the reference stands alone. The entry keeps the reasoning; the reference carries the rule. A reader who needs the rule must not have to read the history to find it.

## Relationship to the other records

| Record | Answers | Mutable |
| --- | --- | --- |
| `__ai/worklog/` | What happened, and what was believed at the time | Append-only |
| `references/DECISIONS.md` | What is settled now | Yes, deliberately |
| `references/INVARIANTS.md` | What must always hold | Yes, deliberately |
| `references/DOCUMENTATION_STATUS.md` | What is still unknown | Yes, as things resolve |
| git history | What the bytes were | No |
