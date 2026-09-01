# Phase 2 slice 2 — organ resolution and the error registry

## Ask

"Analyze what we left off and how to continue", then "let's proceed". Phase 2's remaining work
splits into five items; this slice took the two that are domain-heavy and testable without a node —
the region table with organ resolution both directions, and the contract error registry. Voting
reads, `VotingCreated` discovery, the `ValueAdded` fragment, and preflight stay for slices 3 and 4.

One decision was surfaced first, as a `ROUTER.md` stop condition requires: the enumeration bound for
the `bytes32` → organ reverse table. Inspection narrowed it before asking — every event carries the
organ as a bare `bytes32` (`Votings.sol:127-140`), the triple appears nowhere on chain, and the
global and regional organs are a **closed set of 297** needing no bound at all. Only the two local
types take a `uint256` number. The user chose **0–99, configurable**, with an unlisted hash showing
verbatim rather than being guessed.

Mid-slice the user added a constraint that reshaped the test design: **`temporal_docs/` is deleted
once the implementation plan completes.**

## Changes

**The region table is derived, not transcribed.** `Regions.sol` was parsed to emit
`domain/organs/regions.ts`, and the test re-parses it on every run rather than restating 98 rows a
second time — a test that repeated the table by hand would agree with a transcription error. The
parse independently reproduced three claims in `CONTRACT_DEFECTS.md`: 98 members, the ordinal
differing from the subject code for exactly **50** of them, and all three worked examples (code 95 →
Lugansk, 82 → Moscow 97, 59 → Pskov). It also confirmed the `// = NN` comments agree with
`toString`, which is behavior; the test keeps checking that, and would report the comment rather than
the table if they diverged.

**The two numbers are separate branded types with no conversion between them.** `RegionOrdinal` and
`SubjectCode` meet only in the table, so `regionBySubjectCode` is the single route from a form's
answer to a call argument, and nothing accepts a bare `number` as a region. This is the shape the
defect argues for: for 50 of 98 regions there is no numeric relationship to convert, so offering a
conversion would be offering the bug.

**Organ scope is modelled and normalized.** Three of the eight types ignore `region` and `number`
entirely (`PartyOrgans.sol:75-80`), so `partyOrganTriple()` forces those fields to zero. Without it a
Chairperson organ carrying a stray region compares unequal to itself, which would break dedup keys
and equality checks later. The fork test confirms the contract agrees rather than trusting our own
normalization to justify itself.

**Forward resolution is verified, not trusted.** Both helpers are `pure`, so checking every
resolution costs one round trip and nothing else — and it has to be *every* resolution, because the
failure is per-call. `ZaryaOrganResolver` cross-checks three facts: the contract's identifier equals
the locally composed one (this is what catches a wrong ordinal, since the identifier carries the
subject code), the contract's `bytes32` equals the local keccak of that identifier (this catches a
broken local mirror, including a Cyrillic postfix mangled in transit), and both calls answered.
Disagreement throws; it never returns a hash nobody vouched for.

**The reverse table is the one place the client hashes an identifier itself**, and it is a deliberate
exception to the skill's rule, which governs the forward direction. There is no getter to invert a
hash, so candidates must be enumerated. 297 closed entries plus 98 × 100 × 2 local ones = **19 897**.
An unlisted hash returns `undefined` — an organ we cannot name is a display gap, an organ we name
wrongly is a governance error.

**The error registry separates meaning from decoding.** `domain/chain/contractErrors.ts` names all
21 errors and assigns each a disposition — `ALREADY_DONE`, `NOT_YET`, `REJECTED`, `TERMINAL` — so
the executor's rules are asserted without a node or a revert payload. `InsufficientVotes` and
`InvalidOrgan` are the two terminal ones, and a test pins that list so a third cannot appear
unnoticed. `CallOutcome`'s `UNKNOWN` member keeps three reasons distinct: only `NOT_A_REVERT` is
retryable, because an outage is reconcile-later while an unnameable selector is a real answer we
cannot read.

**Five error fragments were hand-written** because no ABI can carry them: `NoThemeSet`,
`NoStatementSet` and `InvalidCategory` are raised from `external` library functions, and
`Panic`/`Error` are compiler-generated. viem appends its own `Panic`/`Error` during decoding; ours
come first so the decode does not depend on that surviving an upgrade.

**Two things the lint guard forced, both improvements.** Domain tests reading `Regions.sol` tripped
the `node:*` restriction — correctly, since the override covers test files too. The fix was
`src/testing/soliditySource.ts`, outside both layers and in no build entry, rather than an exception
in the rule that would have applied to production modules next time. It also consolidated `.sol`
parsing that three test files had started duplicating.

**The `temporal_docs` removal is designed for, not deferred.** Every source-parsing suite is
`describe.skipIf(!hasSoliditySource(...))` — the same opt-in shape as the fork tests. What survives
the deletion is the stronger evidence, not the weaker: the fork test resolves all 98 regions and all
8 organ types through the deployed contract, and literal keccak digests plus literal error selectors
pin the local mirrors with no file dependency. `errorDecoder.test.ts` gained the selector pins for
exactly this reason — those three errors are absent from the ABI *by construction*, and a deployed
contract cannot be asked what it *would* revert with.

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
 Test Files  20 passed (20)
      Tests  236 passed (236)

$ npm run ai:validate
AI package OK — 16 skills, 43 documents (12 worklog), 3534 lines,
71 ABI and 596 source symbols cross-checked.
```

Up from 13 files / 132 tests. New: `regions` (14), `partyOrgan` (20), `contractErrors` (14),
`errorDecoder` (24), `organLabelTable` (14), `organResolver` (11), `organResolver.fork` (7).

**Against the real deployed contract**, on anvil forking Sepolia — all 7 new fork tests pass:

- one organ of **every one of the eight types** resolves, with the contract's identifier and the
  local one identical and the contract's hash equal to the local keccak;
- **all 98 regions** sweep for one organ type and match their subject codes in order — the check
  that would catch a table shifted by a row, which a spot check on Chelyabinsk cannot, since its
  ordinal and code coincide;
- a Chairperson triple carrying a stray region and number resolves to the *same* organ, confirmed by
  the contract rather than by our normalization;
- ordinal 20 renders `95.СОВ` and ordinal 95 renders `81.СОВ` — both succeed, neither reverts, and
  they are different organs. That is the defect demonstrated live, and the reason the ordinal is a
  branded type rather than a number a form can supply;
- a region ordinal of 200 fails rather than resolving.

The 98-region sweep runs in 141 ms: `pure` functions need only the contract code, which anvil fetches
once and then answers locally.

**The resolver's rejection paths are unit tests, not fork tests**, driven by a stub client that
encodes real ABI return data. An honest fork cannot produce a contract that disagrees with itself, so
the three cross-checks are exercised by making the stub lie — a different label, a matching label
with a wrong hash, and a call that answers nothing. Also asserted there: the ordinal reaches the wire
as `20`, and no Cyrillic ever appears in calldata.

**The `temporal_docs` removal was rehearsed, not assumed.** The directory was moved aside and the
suite re-run: `214 passed | 8 skipped`, green, with the three `errorDecoder` source checks and the
five region/organ ones skipping and nothing failing. The directory was restored and `git status`
confirms no deletion. A degradation path nobody has watched degrade is a claim, not a design.

**One check strengthened after writing it.** The first draft of the hash test asserted
`organHashOf(ORGAN_POSTFIX.chairperson) === organHashOf('ПРЛ')`, which is true by construction and
proves nothing. Replaced with literal digests computed independently, so a UTF-16 encoding, a padded
`encodePacked`, or a postfix corrupted by a console codepage fails there. The same applies to the
error selectors, which were first written as guesses and then computed.

## Unverified

- **The reverse table is verified by sampling, not exhaustively.** The fork test checks 98 + 8
  entries against the contract; the other ~19 790 rest on the local keccak being right, which those
  106 plus the pinned digests support but do not prove entry by entry. Hashing all of them on chain
  would be ~19 897 `eth_call`s.
- **The bound is a guess about the world, not about the code.** Local organ numbers above 99 exist as
  far as the contract is concerned. They resolve forward correctly and display as a bare hash. Nothing
  yet tells a user *why* a hash is showing.
- **No preflight, no reads, no writes** — this slice resolves organs and classifies errors and does
  nothing with either yet. The dispositions are asserted as rules; no caller consumes them.
- **`InsufficientVotes` is classified as terminal from source reading, not observed.** No voting has
  been executed. The classification rests on `Votings.sol:429` and `CONTRACT_DEFECTS.md`.
- **`NoThemeSet`, `NoStatementSet` and `InvalidCategory` have never been decoded from a real
  revert.** Their fragments match the declarations and their selectors are pinned, but no call has
  produced one — the paths that raise them need matrix state this client cannot yet create.
- **`npm run ai:validate` will break when `temporal_docs/` is deleted.** It `fail()`s on a missing
  `.sol` and cross-checks 596 source symbols. The test suite is ready for the removal; the validator
  is not. Flagged, not fixed — what it should do instead is a decision, not a cleanup.
- **`npm start` was not run this slice.** Nothing here is wired to the worker, IPC, or the renderer;
  the worker protocol is unchanged at v2.
