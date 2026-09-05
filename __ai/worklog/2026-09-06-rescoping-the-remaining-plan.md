# Rescoping the remaining plan

## Ask

*"How much left?"* — answered as 13–18 slices. Then *"could it be somehow
optimized?"*, and on agreeing the answer: *"let's stick with this optimized new
scheme, reflect that in the docs of AI."*

Documentation only. No source file changed.

## Changes

**`IMPLEMENTATION_ORDER.md`** — a new section stating the three changes and the
reasoning, then Phases 6-remaining through 10 rewritten around them. Phase 8 is
retitled from "batch engine" to "bulk import" with what is in and what is out
listed separately.

**`zarya-batch-engine` skill** — a Scope note at the top, and its description
narrowed. The "Dependencies" section is kept and marked deferred rather than
deleted: it is the design to return to, and rewriting it from scratch later
would cost more than leaving it.

**`USE_CASES.md`** — bulk execution rows 3–5 struck through with the condition
for reinstating them. Row 8 of form intake corrected too, which was stale from
the slice before this one: it described the tamper comparison, which no longer
exists.

**`STATE_MACHINES.md`** — `WAITING_FOR_DEPENDENCY` removed from the operation
states; the tamper-disclosure transition rule marked superseded.

**`ARCHITECTURE.md`** — `BatchStore` no longer claims dependency edges.

**`DECISIONS.md`** and **`ROUTER.md`** — the narrowing recorded where each is
read from.

## Decisions

**The batch engine loses its dependency machinery, and that is a capability
being dropped rather than a reordering.** The DAG, cycle detection,
`WAITING_FOR_DEPENDENCY` and `WAITING_FOR_ONCHAIN_CONDITION` rest on an
assumption nothing supports: that one governance operation must wait for
another. The contract declares no such relation and no requirement has named
one. It was also the largest remaining phase.

**The condition that reverses it is written down, in the skill and in the use
cases:** a requirement in which an operation must not be submitted until another
has finalized on chain. Deferring something without recording what would bring it
back is how a decision becomes an accident.

**The design is deferred, not deleted.** A struck-through table row and a section
marked deferred cost nothing to carry and preserve the thinking; deleting them
would mean rediscovering it.

**Wiring moves ahead of building.** Nine thousand lines are reachable only from
tests, and every defect this project has actually hit was found by running the
application rather than by the suite. Recorded with that evidence rather than as
a preference, because it is the kind of ordering that gets quietly reversed.

**Phase 9 is committed to "plain" in writing.** It carried most of the schedule
risk. Stating the finish level in the plan is what makes it a decision instead of
a thing that drifts.

## Evidence

```text
$ npm run ai:validate
AI package OK — 16 skills, 66 documents (35 worklog), 7553 lines,
71 ABI and 2043 source symbols cross-checked.
```

No code changed, so no test result is claimed. `ai:validate` is the check that
applies: it verifies structure, links, and doc-vs-source drift across the package,
and it passes with the batch skill's scope note and the struck-through rows in
place.

Estimate after the rescope: **9–12 slices**, from 13–18.

## Unverified

- **The estimate is an estimate.** Nothing about 9–12 has been tested, and Phase 9
  remains the part nobody can size until some of it exists.
- **The dependency assumption is mine, from the contract and from the absence of a
  requirement.** The party has not been asked directly whether one governance
  operation ever waits on another. If the answer is yes, this rescope is wrong and
  the deferred design comes back — cheaper than it would have been to build it
  now, but not free.
- **Nothing here changes what has been verified by hand**, which is still: no form
  and no receipt opened in a viewer, no form filled in a real PDF viewer, and
  nothing broadcast on any network.
