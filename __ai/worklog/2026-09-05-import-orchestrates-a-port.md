# The import use case orchestrates a port, and lint now says so

## Ask

An audit of the session's code against the rules the `__ai` package establishes, then *"go"* to fix
what it found.

## Changes

**The violation.** `src/app/importReturnedForm.ts` imported four modules out of `src/adapters/forms/`
as runtime values. `ARCHITECTURE.md` defines `src/app/` as *"use cases that orchestrate ports"*, with
application services above the domain core that owns the interfaces. Its sibling
`issueOperationTemplate` obeys that through `TemplateWriter`; import did not.

- **`domain/ports/ReturnedFormReader.ts`** — the mirror of `TemplateWriter`. Two steps, because the
  record has to be fetched between them: `read(bytes)` says which operation the file claims, then
  `bind(record, scope)` reconciles the two. What crosses is domain-shaped — `OperationRef`,
  `OperationType`, an `IntentInput` keyed by domain key — so no field name reaches the app layer,
  which `ARCHITECTURE.md` forbids.
- **`adapters/forms/returnedFormReader.ts`** — composition only. The parser, the reference read, the
  record binding and the schema assembly are unchanged and already tested.
- **`resolvedKeys` now travels on the binding** instead of the use case calling `resolvedKeysFor`,
  which keeps the schema behind the port with the rest of the form vocabulary.
- **`getAppStatus`** had the same violation in miniature: it imported the runtime constant
  `NOT_CHECKED` from the chain adapter. Moved to `getAppStatus`, where it belongs — the chain never
  produces it, since `toNetworkStatusView` converts verdicts a provider actually returned.
- **ESLint enforces it now.** `@typescript-eslint/no-restricted-imports` on `src/app/**` with
  `allowTypeImports: true`: a type carries no runtime coupling, a value import is the binding that
  is forbidden. Verified by the two errors it raised on the pre-existing code.

**One behavioural detail preserved deliberately.** The refusal order is still deployment → state →
form content, so a form from the wrong deployment is refused as such even when that operation has
also already been imported. `bind` is pure, so running it before the state check costs nothing.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  70 passed (70)
      Tests  950 passed (950)      # unchanged: a refactor, not a feature

$ grep -n "^import {" src/app/*.ts | grep adapters | grep -v test
(no output)
```

That last command is the check that matters — zero runtime imports from `src/app/` into an adapter.
Before the change it returned four lines from `importReturnedForm.ts` and one from `getAppStatus.ts`.

`ai:validate` reports 16 skills, 60 documents, 71 ABI and 1,868 source symbols cross-checked.
`ARCHITECTURE.md`'s port inventory gains `ReturnedFormReader`, `MatrixSnapshotSource` and
`FileSource`, and a duplicated `ReceiptStamper` row introduced by the edit was removed.

## Unverified

- **Nothing was run.** This is a refactor behind a green suite; the app was not launched and no
  button was pressed after it. The import path's manual test is still outstanding from the previous
  entry.
- **The new lint rule is only proven against the two cases it caught.** It has not been tested
  against a type-only import from an adapter in `src/app/` written after the rule existed —
  `getAppStatus` exercises that, but it predates the rule.
- **`FormParser` is still listed in the port inventory** as an unimplemented port. It is now covered
  by `ReturnedFormReader`; whether the row should be struck or kept for a narrower future use was not
  decided.
- **Two README instructions remain unfollowed from earlier in the session**: `CONTRACT_DEFECTS.md`
  was not read before planning, and `DOCUMENTATION_STATUS.md` was not read at all. The after-the-fact
  audit found no code affected, but that is not the same as having followed the process.
