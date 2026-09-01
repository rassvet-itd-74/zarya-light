# Phase 3 slice 1 — the intent union, validation, and identity

## Ask

"Good now to the next phase." Phase 3: the typed allow-listed intent model. This slice is the union
itself, the validation that builds it from raw form text, fixed-point normalization, semantic
identity, and the mapping from each variant to the `AuthorizationRule` Phase 2 established. The
exhaustive dispatch to contract calls and the simulator arm that consumes it are slice 2.

## Changes

**Eleven variants, and the twelfth is absent on purpose.** `ExecuteVoting` is not in the union, and
that absence is enforcement rather than an omission: the form pipeline cannot construct what does not
exist as a type. There is likewise no `CallContract`, no target address, no calldata, no ABI
signature and no method name read from a field. A returned PDF cannot name a function — it can only
pick one of eleven operations this client already knows how to perform.

**The two threshold setters became one intent.** The plan named `SetMinimumQuorum` and
`SetMinimumApprovalPercentage` separately. They cannot be separate: an organ whose
`approvalPercentageBase` is zero falls back to `simpleMajority` *in its entirety*, so a form setting
only a quorum produces a transaction that succeeds and changes nothing — and no getter exists to
notice. `CONFIGURE_ORGAN_THRESHOLDS` carries all three, and validation refuses a quorum or approval
submitted with a zero base before any chain read, because that is a statement about the request
itself. A base of zero *alone* is allowed: that is the deliberate reset, and refusing it would remove
the only way back to the default.

Validation also refuses an approval at or above its base. The contract's comparison is a strict `>`
against the base-scaled ratio, so `10000` of `10000` would need more than every vote in favour — an
unmeetable threshold that would look configured and silently block the organ.

**A form asks for a subject code; only the table turns it into an ordinal.** A human knows `74` or
`95`, not the position of a member in a Solidity enum, and the two differ for 50 of the 98. So the
accepted values of the region field are the table's own subject codes — derived from it, not
restated — and `regionBySubjectCode` is the only route to an argument. A form carrying `20`,
Chechnya's *ordinal*, is refused rather than resolved to something else. The test is keyed on
Chechnya throughout, since Chelyabinsk's ordinal and code coincide and would hide the bug.

**Fixed point rejects, never rounds.** `12.345` against a two-decimal cell is refused with both
numbers named, because rounding turns a typo into a proposal people vote on. There is no flag to
enable rounding; a caller that wants one must round visibly before getting here. It lives in
`domain/matrix/` rather than `domain/intents/`, because the scale is a property of the *cell* and the
matrix report needs the same conversion — placing it with its first consumer would have made the
report import from `intents/` to render a number.

**The intent carries the decimals it was scaled with.** The contract does not take them; they are
stored per cell. That is exactly why they have to travel: a template issued against a two-decimal
cell and returned a week later, after a decimals voting changed it to four, would otherwise submit a
number a hundred times too small with nothing on chain to notice. Preflight compares the two.

**Vote identity deliberately excludes the direction.** `FOR` and `AGAINST` on one voting from one
signer produce the **same** key, and `relate` reports `CONTRADICTION`. Putting direction in the key
would make them look unrelated, both would be submitted, and the second would revert `AlreadyVoted` —
which the registry classifies as idempotent completion. A contradiction would have been reported as
success. Proposal duration is excluded for a duller reason: proposing the same membership change for
a day or a week is the same proposal.

**Free text in a key is length-prefixed.** Without it a theme of `a|b` and a theme of `a` followed by
a component `b` produce the same key — a collision the author controls, and therefore a way to make
one proposal dedup against another.

**Text is normalized to NFC and screened for direction overrides.** `й` written as `и` plus a
combining breve is visually identical, compares unequal, and would produce two dedup keys for one
proposal. Separately, the bidirectional overrides let a stored statement render in an order different
from the one it is read back in, which is a way to make a proposal display as something other than
what people voted on.

**Zero addresses are refused where the contract accepts them.** `valueAuthor` is never validated on
chain, and a checkpoint encodes as `author << 64 | value` — so a value of `0` authored by `0x00…00`
encodes to zero, which `get*ValueAtTimestamp` reads as **not found**. The write succeeds and the
value is invisible. Refusing the zero author makes that unreachable.

**Authorization is assigned by hand and never inherited.** `intentAuthorization.ts` maps each variant
to one rule, exhaustively. The arm most likely to be wrong is `CONFIGURE_ORGAN_THRESHOLDS`: it names
an organ, and that organ is the **target**, not the authorizer. Passing it to a membership rule would
make every member of an organ appear entitled to set its own thresholds. It is `CHAIRMAN_ONLY`, and
there is a test that says so.

## Two things this slice got wrong first

- **The result type used an `ok: boolean` discriminant**, which every other union in this codebase
  avoids. It does not narrow here, and chasing why turned up the reason below. Now `kind: 'INTENT' |
  'PROBLEMS'`, matching `CallOutcome`, `PreflightVerdict` and the rest.
- **Two tests asserted that surrounding whitespace is refused.** It is trimmed, once, for every
  field — a PDF field routinely picks up a trailing space and no governance value is distinguished by
  one. The tests were wrong, not the code, and they were replaced by one that asserts the trimming
  explicitly rather than by deleting the question.

## `strict` was off, and the tree already satisfied it

Chasing the discriminant failure found that `tsconfig.json` did not enable `strict`. That matters
here more than in most projects: **every reader in the chain adapter returns `T | undefined` to keep
"could not read" apart from "false"**, and without `strictNullChecks` `undefined` is assignable to
`boolean` — so the rule Phase 2 was built around was enforced by discipline alone, not by the
compiler. `VotingReader.isMember` could have returned `undefined` into a `boolean` and nothing would
have said so.

`npx tsc --noEmit --strict` reported **zero errors** before the flag was set, so it was turned on as
a tightening with no migration: 41 test files and 511 tests unchanged. It also restores narrowing for
boolean-literal discriminants, which is what went wrong above.

## Evidence

```text
$ npm run typecheck          # now with "strict": true
> tsc --noEmit
(no output — clean)

$ npm run lint
> eslint --ext .ts,.tsx .
(no output — clean)

$ npm test
> vitest run
 Test Files  41 passed (41)
      Tests  511 passed (511)

$ npm run ai:validate
AI package OK
```

Up from 37 files / 440 tests. New: `fixedPoint` (12), `buildIntent` (30), `identity` (18),
`intentAuthorization` (11).

`buildIntent` sweeps all eleven operation types through a builder and asserts the union has no
`EXECUTE_VOTING`. `intentAuthorization` sweeps all eleven for a rule, and asserts that a Chairman who
is not a member is **denied** all four matrix-configuration proposals — the half of the creation
surface where the override does not apply.

## Documentation corrected

`USE_CASES.md` rows 12–13 of "Form-driven governance" still described quorum and approval as two
independent cases, which predates the base-as-enable-flag finding. Rewritten as one operation
carrying three values, with the reason. The Phase 3 bullets in `IMPLEMENTATION_ORDER.md` named the
same two setters and were corrected the same way.

## Unverified

- **No intent has ever produced calldata**, let alone a transaction. The dispatch is slice 2, so
  nothing here has been checked against the ABI's argument order — the union's shape agrees with
  `CONTRACT.md` by reading, not by encoding.
- **Nothing has ever built an intent from a real form.** The input is a `Record<string, string>` of
  domain-named keys, and the mapping from `zarya.input.*` onto those keys is Phase 4's. The two could
  disagree today and nothing would fail.
- **The text limits are judgements.** 200 characters for a theme, 400 for a statement, 64 for a
  category name. The contract bounds none of them, nothing was measured, and a real governance
  document may want more.
- **`relate` compares two intents, not a batch.** Detecting a contradiction across a whole import is
  Phase 8's, and the pairwise rule is what it will be built on rather than what it uses.
- **`VotingRef` has one arm.** A batch item that needs to name a voting an earlier item will create
  cannot express it, which is deliberate — the form schema has no field to carry it yet. Adding the
  second arm later is a compile error at every consumer, which is the review it deserves.
- **`strict` is on and has never rejected anything.** It was zero-error at the moment it was
  enabled; its value is entirely in what it will catch next.
- **Nothing is wired to the worker, IPC, or the renderer.** `npm start` was not run; worker protocol
  stays at v2.
