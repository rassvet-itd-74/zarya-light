# Phase 6 slice 1 — the write lifecycle, its persistence, and recovery

## Ask

*"Go"* — start Phase 6, the transaction queue, at pace. Scoped to the lifecycle and recovery;
receipt stamping is slice 2, and nothing is wired to a trigger.

## Changes

**Ports.** `Signer` (identity + submit), `ReceiptReader` (outcome + pending nonce),
`WriteCallEncoder`, `TransactionStore`. `ARCHITECTURE.md` planned one `ChainWriter` doing submit and
await; it became two, split along **secrets** — signing needs key material and reading does not, so
recovery can ask what a nonce did with no wallet in scope.

**`domain/transactions/transactionLifecycle.ts`** — `READY → SIGNING → BROADCAST → PENDING →
CONFIRMED`, plus the two failure states. `SIGNED` is named in the skill and absent here because there
is no outbox.

**Schema v3** — a `transactions` table keyed by `attempt_id`, not `operation_ref`: a reverted
transaction still consumed a nonce and still happened, so resubmitting is a new row. `hash` and
`nonce` are separately nullable because the gap between them *is* crash window three — a row with a
nonce and no hash is recoverable, and one with neither was never sent.

**`submitOperation`** — the only thing in this application that broadcasts, wired to no trigger.
Serializes per signer by asking the **store** what is in flight rather than holding a flag, because
the case it guards is a process that died.

**`reconcileTransactions`** — never broadcasts, so it is safe on startup and on demand.

**Adapters** — `PrivateKeySigner` over a viem wallet client, `ZaryaReceipts` over a public one.

## Decisions

**No signed outbox, deliberately.** A persisted raw signed transaction is a bearer instrument sitting
in a file a user's backup copies. `zarya-transactions` permits storing them "only if the security
model explicitly accepts it"; this one does not. The cost is stated rather than hidden: after an
ambiguous broadcast this client cannot rebroadcast identical bytes, so it recovers **by nonce**.

**`PENDING` has no edge to failure.** An unread receipt is an outage, not a verdict.

**A spent nonce with no hash stays unresolved and keeps the queue blocked.** The one case recovery
cannot close. Marking it failed invites a resend under a nonce that is gone; marking it confirmed
claims an outcome nobody read.

**`CONFIGURE_ORGAN_THRESHOLDS` has no atomicity across its three calls**, so a failure part-way
returns `PARTIALLY_SUBMITTED`. Calling it a refusal would be false about an organ that is genuinely
part-configured.

**The state machine was wrong on its first pass, and a test caught it.** `BROADCAST` had no failure
edge at all, on the reasoning that a broadcast is unknowable. Too strong: a provider's pending nonce
still sitting at the value this row assigned is a *proof* that nothing under it was mined. Without
the edge, provably-unsent rows would have stayed in flight forever and blocked the queue. The edge
now exists and is unreachable from the send path — only reconciliation takes it, and only on that
evidence.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test
typecheck=0 lint=0 test=0

 Test Files  72 passed (72)
      Tests  969 passed (969)      # was 961
```

Eight new tests in `transactionCrashWindows.test.ts`, against a real SQLite database, covering the
windows `zarya-transactions` requires:

- **before signing** — the row is durable in `SIGNING` with no nonce, and recovery closes it as never
  sent, because a missing nonce is *evidence*: `submitOperation` writes the nonce before the hash.
- **after broadcast, nonce free** — closed as never sent.
- **after broadcast, nonce spent** — left `BROADCAST` and reported `UNRESOLVED`.
- **after the hash** — no receipt keeps it `PENDING`, unchanged.
- **after mining** — a revert is recorded as `CONFIRMED` with `outcome: REVERTED`, and the hash
  survives the transition rather than being erased by one that learned other things.

Plus the serialization guard, the wrong-chain refusal writing nothing, and the three-call partial.

## Unverified

- **Nothing has been broadcast, on any network.** Every test uses a fake signer. Hard rule 1 stands:
  nothing goes to Sepolia without being asked.
- **The viem adapters have no tests at all.** `PrivateKeySigner` and `ZaryaReceipts` are typechecked
  and unexercised — no anvil test, no fork test. The revert-reason replay in particular is a guess
  about what a provider returns and has never run.
- **Not wired.** No IPC channel, no button, no worker request. `submitOperation` is reachable only
  from tests, which is the same condition the vertical slices exist to end — deliberate here, since
  wiring a broadcast path needs the manual verification below first.
- **Crash window 2 does not exist** in this design, since there is no outbox. Recorded rather than
  claimed as covered.
- **No fee handling, no replacement-by-fee, no stuck detection.** A transaction that never mines
  stays `PENDING` and blocks the queue with no way to clear it but a database edit. That is the
  largest gap in this slice.
- **The four manual checks from earlier entries are still outstanding**, including the real database
  at `%APPDATA%` — which now has *two* migrations to apply rather than one.
