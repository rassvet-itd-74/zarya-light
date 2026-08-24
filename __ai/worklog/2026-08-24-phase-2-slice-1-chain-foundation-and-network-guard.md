# Phase 2 slice 1 — chain foundation and the network guard

## Ask

Stand up the chain adapter's foundation and refuse to start against the wrong chain, the wrong
address, or the wrong deployment. Provider wiring behind a port, a `NetworkGuard` checking chainId
through the domain's existing rule plus a contract-code check, the `castVote` arity discriminator
from `DEPLOYMENT.md`, and the `Clock` port's first implementation. Reads only — no signer, no write
path.

Three decisions were surfaced first, as the task required. The user chose **viem**, **anvil for
everything including this slice** (against my recommendation of a fake transport here), and **move
the ABI** under `adapters/chain/`. Mid-slice the user redirected twice: no compiling of
`temporal_docs` — fork Sepolia and use the bundled ABI instead — and drop the predecessor deployment
from scope entirely.

## Changes

**The ABI moved** to `src/adapters/chain/abi/Zarya.abi.json`, where `ARCHITECTURE.md` always said it
belonged. Nothing imported it yet, so this was the last cheap moment. Fifteen references followed it.
Two did not and could not: append-only worklog entries name the old path in their narrative, so the
validator's cross-link pattern now covers `src/adapters/chain/abi/` and no longer `src/chain/abi/` —
the same precedent as the `contracts/` removal. The validator also held the path a second time inside
a `join()` call that a string-level replace missed; it caught that itself by failing on every
ABI-only symbol citation, which is the check doing exactly its job.

**Observation and decision are separated.** `domain/network/networkIdentity.ts` is a pure classifier:
`NetworkObservations` in, `NetworkVerdict` out. `adapters/chain/networkGuard.ts` only gathers facts.
This is what makes the wrong-deployment path testable at all now that the predecessor is out of
scope — an empty revert is a fixture, not a live contract.

The type is shaped by one rule: **an unobserved fact is not a failed one.** Every observation may be
`undefined`, and every `undefined` yields `UNREACHABLE` rather than a rejection. `isTransientVerdict`
exists so callers can tell "retry later" from "fix your configuration", and the two render
differently in the UI.

**Four distinct verdicts, not one.** chainId (through the domain's existing `assertPermittedNetwork`,
not a second copy of the rule), contract code, an eligibility fingerprint, and the `castVote` probe.
Two findings made this cheaper and stronger than planned:

- `Zarya.sol:566` rejects `votingId == 0` in `votingExists` *before* any membership logic, so
  `eth_call` of `castVote(0, false)` needs no signer, no `from`, and touches nothing. There is no
  `fallback` or `receive` in `Zarya.sol`, so the same selector against a contract lacking it reverts
  with empty returndata. Decodable error → right interface; empty revert → wrong deployment.
- `simpleMajority` is initialised inline at `Zarya.sol:27-28` and assigned nowhere else, so
  `{1, 5000, 10000}` is a free, non-reverting identity fingerprint — far stronger evidence than
  "the address has code".

**Telling a revert from a transport failure** got its own module. The two arrive at the same catch
site and mean opposite things, and confusing them reports an RPC hiccup as a wrong deployment.
`revertData.ts` matches duck-typed over the cause chain and returns "not a revert" when unsure —
unknown, not condemned.

**The ABI is asserted, not trusted.** Importing it as JSON widens the type to `Abi`, so viem cannot
infer per-function types. Rather than hand-writing signatures back (which `zarya-chain` forbids for
good reason), `assertAbiContract()` checks at load that each function this code calls exists exactly
once with the expected arity. "Exactly once" matters as much as the arity: an ABI carrying both
`castVote` forms would let a call site pick either.

**Wired through to be observable.** The worker loads its own configuration from the inherited
environment — so the RPC URL never travels in a message — and answers a new `checkNetwork` request;
`AppStatus` carries the verdict; the renderer shows it. `NOT_CHECKED` is a distinct state from every
failure, because "we have not looked" must not render as "it is wrong". Worker protocol version
bumped to 2.

**Two small additions beyond the brief**, both to make `npm start` demonstrate the slice: `.env`
loading in the main process, guarded to development so a packaged app never picks up a stray file
from its launch directory; and the same for tests via `vitest.setup.ts`, using Node's built-in
`process.loadEnvFile` rather than a dotenv dependency.

**One documentation mismatch found and recorded.** `whitepaper.md:426` gives `simpleMajority` as
`(quorum=1, approvalPercentage=50, base=100)`; the source says `{1, 5000, 10000}`. Same value,
different units. `DOCUMENTATION_STATUS.md` covered this as a class but not as a line; it does now.

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
 Test Files  13 passed (13)
      Tests  132 passed (132)

$ npm run ai:validate
AI package OK — 16 skills, 42 documents (11 worklog), 3348 lines,
71 ABI and 264 source symbols cross-checked.
```

**Against the real deployed contract**, on a local anvil forking Sepolia — all 7 fork tests pass:
the configured deployment is accepted; an address holding no code is rejected as `NO_CONTRACT_CODE`;
a fork run with `--chain-id 1` is refused as `WRONG_NETWORK` even though the contract is present;
`Clock.chainTime()` matches the block timestamp and is unchanged when `Date.now` is moved a decade
into the future; and killing the node yields `UNREACHABLE`, with `OK` again after a restart.

Without `ZARYA_FORK_RPC_URL` the same suite reports `7 skipped` and the run stays green, so an
offline check never depends on Sepolia.

**`npm start`, observed:** the window reports *"Connected to Sepolia at block 11559454."* against the
configured address, with worker protocol v2. The RPC host row shows `eth-sepolia.g.alchemy.com` and
not the API key in the URL — the Phase 1 public/secret split holding under a real provider URL. An
earlier run against the default `rpc.sepolia.org` rendered the `UNREACHABLE` verdict in amber with
"This is not a rejection — it will be retried", which is the invariant visible in the product.

**A harness bug worth recording.** The reconnect test first failed with `OK` where `UNREACHABLE` was
expected. Cause: `spawn(..., { shell: true })` on Windows wraps anvil in a `cmd.exe`, so `child.kill()`
killed the wrapper and left the node answering — three orphaned `anvil.exe` processes confirmed it.
The test had been passing its earlier assertions against a node that never went down. Fixed by
dropping `shell`, killing the tree with `taskkill /T /F`, and waiting for the endpoint to stop
answering rather than trusting the exit event. A test that tears down its subject must prove the
teardown happened.

## Unverified

- **The wrong-deployment path is proven only as a pure unit test.** The predecessor was dropped from
  scope, so `EMPTY_REVERT → WRONG_DEPLOYMENT` is asserted on the classifier, not against a live
  three-argument contract. The classifier is pure and fully covered; what is untested is that a real
  predecessor produces an empty revert rather than something else. `Zarya.sol` having no `fallback`
  is the evidence for that, read from source.
- **The eligibility fingerprint is deployment-specific evidence, not a law.** It holds because
  `simpleMajority` has exactly one assignment in the source we hold. A future deployment that changed
  it would be reported as `NOT_ZARYA` until the constant is updated.
- **Fork tests are only as reproducible as the fork block.** `ZARYA_FORK_BLOCK` is supported but not
  set, so runs currently fork at head. Nothing asserted so far depends on block-varying state.
- **No signer exists, so nothing about signing is verified** — including that the guard would block a
  write. There is no write path to block yet; that arrives in Phase 6.
- **Only the happy path was seen in the packaged sense**: `npm start` ran in development. The
  dev-only `.env` loading means a packaged build takes configuration from the real environment, which
  has not been exercised.
- The default `https://rpc.sepolia.org` did not answer during this slice. It remains the fallback
  when `ZARYA_RPC_URL` is unset, and is worth reconsidering when a default matters.
