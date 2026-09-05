# Phase 6 slice 4 — testing the two chain adapters, and what that found

## Ask

*"Move on to the next piece of work."* Chosen: tests for `PrivateKeySigner` and
`ZaryaReceipts`, listed as unverified in three consecutive worklogs. They are the
code that will actually touch Sepolia, and wiring a button to untested adapters
would be backwards.

Deliberately **not** the send-path wiring. That creates the application's first way
to broadcast and should be an explicit decision, not a side effect of "next".

## Changes

**`zaryaReceipts.test.ts`** (new) — twelve cases against an injected fake client.
What is under test is not viem but this adapter's refusal to turn an outage into a
verdict: a missing receipt, an unreadable block, a failed replay and a dead
provider all have to answer "keep waiting" rather than "failed".

**`zaryaSigner.test.ts`** (new) — ten cases with no network: identity derived
without a round trip, and hard rule 2 as an executable check across
`JSON.stringify`, `util.inspect`, `String()`, structured clone, and a walk of the
object's own and prototype property names.

**`zaryaSigner.fork.test.ts`** (new) — six cases against a local anvil forking
Sepolia. **The first test in this repository that sends a transaction.**

**`publicClient.test.ts`** (new) — eight cases pinning the leak fix below at its
construction site rather than on each of the twelve classes that hold a client.

**`publicClient.ts`** — `hideTransportUrl`, applied in `createZaryaPublicClient`.

**`zaryaSigner.ts`** — applied to both of its clients; gained `toJSON`; its class
comment corrected.

## Decisions

**The signer had to be tested by signing.** Nonce assignment, hash derivation and
the ambiguity of a failed send are properties of a real node's response; a fake
provider would only prove a fake was consulted. Everything runs against a local
anvil, the live network is read once at fork time, and the key is anvil's
published account #0. Hard rule 1 forbids broadcasting to a network unasked — a
local fork is not one, and this is the harness `zarya-testing` prescribes. Worth
stating rather than assuming, because it stops being true if anyone points
`ZARYA_FORK_RPC_URL` at a node that forwards writes.

**A found defect, and it was not the one being looked for.** `PrivateKeySigner`'s
comment claimed the class was "`toJSON`-hostile by having nothing to serialize",
so an accidental `JSON.stringify(signer)` yielded `{}`. It yielded 2164
characters across four fields — **including the RPC URL with its API key**, which
`PublicClientOptions` documents as never logged. TypeScript's `private` is erased
at runtime and hides nothing from a serializer.

The private key itself was never in it, so hard rule 2 held throughout. The
comment was the danger: it told a reader that logging a signer was safe, and it
is the reason someone would.

**Fixed at the root, not at the symptom.** Twelve classes in the chain adapter
hold a client and every one of them had the same property. Making
`transport.url` non-enumerable at construction covers all of them, and a
thirteenth inherits it without knowing. Non-enumerable rather than deleted
because viem reads it: the property still resolves for anything that names it,
and `inspect(x, { showHidden: true })` still shows it, which is the escape hatch
for someone genuinely debugging a transport.

**It narrows the leak and does not close it.** A caller that reads the URL and
logs it defeats the whole thing. The code says so and so does `INVARIANTS.md`;
a fix described as airtight would be worse than the leak.

## Evidence

```text
$ npm run typecheck ; npm run lint ; npm test ; npm run ai:validate
typecheck=0 lint=0 test=0 validate=0

 Test Files  78 passed (78)
      Tests  1026 passed (1026)     # was 990

$ npx vitest run src/adapters/chain/zaryaSigner.fork.test.ts
 ✓ 6 tests — against a local anvil forking Sepolia
```

The fork test proves, against real bytecode rather than against a comment:

- the hash is 32 bytes and the nonce is the one the provider was about to
  assign, read back rather than chosen;
- `ZaryaReceipts` resolves that hash to `SUCCESS` with a real Sepolia block
  timestamp in seconds — the value a receipt is later stamped with;
- two sends advance the nonce by exactly one, which a `latest` rather than
  `pending` read would break;
- **a reverting call throws without consuming a nonce.** viem estimates gas
  before signing, so nothing is sent. That is the premise
  `reconcileTransactions` rests on when it treats a free nonce as proof that
  nothing landed, and it had never been checked against a node.

The leak was confirmed before it was fixed, by constructing a signer with a URL
carrying a marker segment and finding that marker in both `JSON.stringify` and
`util.inspect` output. Both tests now assert its absence, and one asserts it is
still visible under `showHidden` so the escape hatch does not rot.

## Unverified

- **`submit` has never been called against Sepolia**, only against a fork. The
  paths that differ there are the ones that matter least to this code and most to
  operations: a real mempool, a real gas market, and a provider that can reject
  what anvil accepts.
- **No ambiguous send has been observed.** The crash window where a provider
  accepts a transaction and the connection drops before the hash returns is
  covered by unit tests over the store, not by anything that has actually
  happened. It is the window recovery-by-nonce exists for.
- **The revert-reason replay is tested only against a fake.** The fork test's
  reverting call fails at estimation, so the real `eth_call` replay path — the one
  that recovers `InsufficientVotes` from a mined revert — has never run against a
  node. Producing a *mined* revert needs a transaction that estimates cleanly and
  then reverts on execution, which needs contract state this fork does not have.
- **`hideTransportUrl` is not proven against a future viem.** It checks for a data
  property and leaves a getter alone, so a viem version that computes `url` would
  silently reopen the leak. The test for that branch asserts the refusal, not the
  outcome.
- Everything the previous slice left unverified is still unverified: **no form and
  no receipt has been opened in a viewer**, and nothing has been broadcast on any
  network.
