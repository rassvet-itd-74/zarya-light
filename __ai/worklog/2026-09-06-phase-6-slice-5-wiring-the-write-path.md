# Phase 6 slice 5 — wiring the write path

## Ask

*"Proceed with this new plan."* Its next item is wiring `submitOperation` to a
trigger, which is the first thing that gives this application a way to broadcast.

Built the path; sent nothing. Hard rule 1 says a transaction is never broadcast
unless explicitly asked, and building the button is not the asking — pressing it
is.

## Changes

**`app/intentFromForm.ts`** (new) — the last two steps of reading a form, resolve
and build, lifted out of `importReturnedForm` so submission can run them again on
the same stored bytes. Import keeps its refusal order untouched.

**`app/submitImportedOperation.ts`** (new) — record → stored bytes → parse → bind
→ derive → `submitOperation`. Everything before the last line is a read.

**`adapters/chain/writeCallEncoder.ts`** (new) — `WriteCallEncoder` over
`encodeWriteCall`. The port existed with no implementation; the one translation
is `ORGAN_UNREADABLE` → `ORGAN_UNAVAILABLE`, which keeps retryable and terminal
apart.

**`SecretConfig`** — carries `memberKey`, validated at load. First key material in
the application.

**Protocol, IPC, preload, main, renderer, `index.html`** — a `submitOperation`
request at protocol version 6, a channel, a confirmation dialog in main, and a
Send button that arms only after an import.

## Decisions

**The renderer names an operation and nothing else.** One `operationRef` crosses.
No intent, no calldata, no address, no amount, no signer. The untrusted UI picks
*which* stored operation to send and cannot influence *what* it is. A payload
that could carry calldata would put a hole in the form pipeline's allow-list one
layer below where anyone would think to look for one.

**The intent is derived again rather than remembered.** Nothing persists an
intent, and this slice deliberately did not start. A stored intent would be a
second copy of the decision that could disagree with the document after a
migration or a bug; re-deriving means the transaction comes from the bytes the
member returned, through the same code that accepted them. It also moves the
numerical scale read to submission time, one step closer to the mined block. The
cost is parsing a form twice, which is one person pressing one button.

**The confirmation is in main, and its limits are written down.** It defaults to
Cancel and names the operation. It stops a **mis-click** — it is not a defence
against a compromised renderer, which could invoke the channel with any reference
and would simply see its own choice named back at it. That boundary is held by
the narrow payload and by the worker deriving everything else. Saying so in the
code matters more than the dialog does: a guard described as stronger than it is
becomes the reason nobody adds the real one.

**A malformed `ZARYA_MEMBER_KEY` is fatal at startup.** Two existing tests carried
`'0xdeadbeef'` as a presence placeholder and now fail; they were changed to a
real-shaped key rather than the check being loosened. A key that cannot sign is
better discovered before a member has filled in a form than at the moment they
press send.

**The signer is constructed per request.** A process that never sends never holds
key material in memory, and the object holding it is garbage as soon as the reply
is posted.

**An unconfigured wallet is a refusal, not a failure.** The read, issue and import
half of this application works without one; a member who has not configured a key
has reached the one action that needs it, not broken anything.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  79 passed (79)
      Tests  1041 passed (1041)     # was 1026
```

`submitImportedOperation.test.ts` — eight cases from a real issued template
through a real fill, a real import and the real stores, with a **fake signer that
records what it was asked to send**:

- the calldata is derived from the stored form, and the attempt lands in
  `PENDING` with its hash;
- **the member's own address, typed into a PDF, appears in the transaction's
  calldata** — the whole pipeline in one assertion, through the schema, the
  record and the ABI;
- an operation with no imported form, an unknown reference, and a signer on the
  wrong chain are each refused **and the signer is never called**. "It refused"
  and "it refused after sending" are the same value and completely different
  events;
- a throwing signer leaves the row in `SIGNING`, not failed, and the next attempt
  is refused `WRITES_IN_FLIGHT`.

`ipcHandlers.test.ts` — the guard that matters: **a declined confirmation reaches
the worker with no request at all**, asserted on the gateway rather than on the
returned value. Plus payload rejection before the dialog can even be raised, and
that a submitted-with-`partial` reply stays a send rather than becoming a failure.

## Unverified

- **Nothing has been broadcast.** Not to Sepolia, not to a fork. Every test in
  this slice uses a fake signer, and the real one is exercised only by
  `zaryaSigner.fork.test.ts` against anvil. The first real transaction this
  application sends will be sent by a person.
- **The confirmation dialog has never been seen.** Its wording, its button order,
  and whether Cancel is genuinely the default in a real Electron modal are
  unexamined — and this is the dialog standing between a mis-click and an
  irreversible action.
- **No end-to-end run.** Issue, fill in a viewer, import, send, reconcile, stamp
  has never happened in sequence. `zarya-testing` calls that the highest-value
  single test in the product and it still does not exist.
- **`ZARYA_MEMBER_KEY` has never been set** on this machine or any other, so the
  signer construction path in the worker has not run once. A typo there would
  present as a refusal at the moment of sending.
- **Gas is not considered anywhere.** No balance check, no estimate shown before
  the confirmation. A member with no Sepolia ETH will discover it as a provider
  error after saying yes.
- **Reconciliation is still unwired**, so a sent transaction stays `PENDING`
  locally until something calls `reconcileTransactions` — which nothing does. The
  receipt cannot be stamped until it does.
