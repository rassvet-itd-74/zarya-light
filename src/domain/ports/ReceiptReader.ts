import type { EvmAddress } from '../primitives';

/**
 * Reading what happened to a transaction, and what a signer's nonce is.
 *
 * `ARCHITECTURE.md` planned one `ChainWriter` doing "submit, await confirmation,
 * return a decoded outcome". It is two ports instead, and the split is along
 * **secrets**: submitting needs key material and this does not. Keeping the
 * reads here means recovery can ask the chain what a nonce did without a signer
 * in scope at all, which is what lets reconciliation run before the queue is
 * unlocked.
 *
 * Every method answers `undefined` for "could not read", never a plausible
 * negative — the convention every chain reader in this client follows. A receipt
 * that is absent because the transaction is still in a mempool and one that is
 * absent because the provider timed out are the same answer here, and the caller
 * treats both the same way: keep waiting. Neither is a failure.
 */

export interface TransactionOutcome {
  /** `REVERTED` is a confirmed answer, not an error. The receipt says so. */
  readonly status: 'SUCCESS' | 'REVERTED';
  /** Decimal string: block numbers are bigint and records are text. */
  readonly blockNumber: string;
  /**
   * The confirming block's own timestamp, in seconds.
   *
   * Read here and stored with the attempt so that stamping a receipt needs **no
   * chain access at all** — which is what makes a lost receipt regenerable, and
   * what stops a workstation clock ever reaching a governance document. A
   * receipt that had to ask the chain for its own date would not be reproducible
   * offline, and the invariant says it must be.
   */
  readonly confirmedAt: number;
  /**
   * The decoded revert name where one could be decoded.
   *
   * A revert with no reason is normal — `CONTRACT.md` lists the errors that
   * exist, and a bare `revert()` names none. `undefined` here means "reverted,
   * reason unknown", which is different from "did not revert".
   */
  readonly revertReason?: string;
}

export interface ReceiptReader {
  /**
   * The outcome of `hash`, or `undefined` while it is not yet knowable.
   *
   * Does not wait. Polling is the caller's, because how long to wait is a
   * reconciliation policy and not a property of a read — and a port that blocked
   * would make "still pending" indistinguishable from "provider hung".
   */
  outcome(hash: `0x${string}`): Promise<TransactionOutcome | undefined>;

  /**
   * The next nonce the provider would assign this address, counting what is
   * already in its mempool.
   *
   * The authority for nonce assignment. This client records what it *believes*
   * it sent (`TransactionStore.highestNonce`), and the two disagreeing is the
   * signal recovery exists to catch — a local record ahead of the chain means an
   * attempt never landed, and the chain ahead of the record means something was
   * sent that this client did not write down.
   */
  pendingNonce(address: EvmAddress): Promise<number | undefined>;
}
