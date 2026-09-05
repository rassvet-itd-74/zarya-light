import type { ChainId, EvmAddress } from '../primitives';

/**
 * Signing, with no way to get the key back out.
 *
 * Hard rule 2: private keys never reach the renderer, the logs, or the database.
 * This port is the shape of that rule — it exposes an **address** and a
 * signing operation, and nothing that returns key material. There is deliberately
 * no `privateKey`, no `export`, and no `mnemonic`; an implementation that added
 * one would be visible in review as a widening of this interface rather than as
 * a line in a function body.
 *
 * ## Why it signs and broadcasts in one call
 *
 * `zarya-transactions` describes an optional outbox — sign, persist the raw
 * payload, broadcast, and rebroadcast the identical bytes after an ambiguous
 * failure. This client does **not** implement it, so there is no method here
 * that hands back a signed transaction.
 *
 * That is a security decision, not an omission. A persisted raw signed
 * transaction is a bearer instrument: anyone holding the row can broadcast it,
 * and it sits in a file a user's backup software copies. The skill's own
 * condition is to store them "only if the security model explicitly accepts it",
 * and this one does not.
 *
 * The cost is stated rather than hidden: after an ambiguous broadcast this client
 * cannot rebroadcast identical bytes, so it recovers **by nonce** instead —
 * asking the chain what that nonce did. See `TransactionStore` and the crash
 * windows in `INVARIANTS.md`.
 */
export interface SignedSubmission {
  readonly hash: `0x${string}`;
  /** The nonce the provider used, read back rather than assumed. */
  readonly nonce: number;
}

export interface SignerIdentity {
  readonly address: EvmAddress;
  readonly chainId: ChainId;
}

export interface Signer {
  /**
   * Who this signer is. Synchronous and cheap: it is derived from the key, not
   * asked of a provider, so a caller can log or display it without a round trip.
   */
  identity(): SignerIdentity;

  /**
   * Signs and submits one call, returning the hash and the nonce used.
   *
   * **Throws** on failure. There is no result arm, because the states this can
   * end in are not a value question: either the provider accepted the
   * transaction and named it, or the caller has an *ambiguous* failure it must
   * resolve by nonce rather than by interpreting a return value.
   *
   * The nonce is not a parameter. Assigning it is the provider's, and reading it
   * back is what makes recovery possible — a nonce this client chose and the
   * provider silently replaced would leave a row describing a transaction that
   * does not exist.
   */
  submit(call: UnsignedCall): Promise<SignedSubmission>;
}

/**
 * One call, already encoded.
 *
 * Calldata, never an intent: by the time anything reaches a signer every
 * governance decision has been made, and a port that took an intent could
 * re-derive one differently from the one that was authorized. `to` is carried
 * explicitly so a signer cannot be pointed at the wrong contract by
 * configuration this layer never reads.
 */
export interface UnsignedCall {
  readonly to: EvmAddress;
  readonly data: `0x${string}`;
}
