import type { ReceiptReader } from '../domain/ports/ReceiptReader';
import type { TransactionRecord, TransactionStore } from '../domain/ports/TransactionStore';
import type { ChainId, EvmAddress } from '../domain/primitives';

/**
 * Resolving what a crash left in flight, by asking the chain.
 *
 * The counterpart to `submitOperation`, and the reason that one refuses to send
 * while anything is unresolved. It reads and writes local state; it **never
 * broadcasts**, so it is safe to run on startup, on reconnect, and on demand —
 * which is what makes "reconcile first" a workable rule rather than a manual
 * chore.
 *
 * ## Two questions, and only one of them can be asked by hash
 *
 * A `PENDING` row knows its hash, so the chain can be asked directly.
 *
 * A `SIGNING` or `BROADCAST` row cannot: either nothing was signed, or bytes
 * left and the answer never came back. This client keeps no raw signed payload
 * (see `Signer`), so it cannot rebroadcast to find out. It asks by **nonce**
 * instead:
 *
 * - if the row has no nonce, nothing was ever assigned and nothing was sent —
 *   the attempt failed before it existed on chain, and is retryable;
 * - if the row has a nonce **below** the provider's pending nonce, something
 *   using that nonce was mined, and this client cannot prove it was *this*
 *   transaction. That is the honest limit, and it is recorded rather than
 *   guessed at.
 *
 * ## What this deliberately does not do
 *
 * It does not resubmit, bump a fee, or cancel. Replacement-by-fee is a separate
 * deliberate feature with its own tests (`zarya-transactions`), and doing it
 * implicitly during recovery is how a stuck transaction becomes two.
 */

export interface ReconcileDeps {
  readonly receipts: ReceiptReader;
  readonly transactions: TransactionStore;
  readonly deployment: {
    readonly chainId: ChainId;
    readonly contractAddress: EvmAddress;
  };
  readonly signerAddress: EvmAddress;
}

export type AttemptResolution =
  /** A receipt was read. `outcome` says whether it reverted. */
  | { readonly kind: 'CONFIRMED'; readonly attemptId: string; readonly outcome: string }
  /** Still in a mempool, or the provider could not say. Not a failure. */
  | { readonly kind: 'STILL_PENDING'; readonly attemptId: string }
  /** Provably never sent: no nonce was ever assigned. */
  | { readonly kind: 'NEVER_SENT'; readonly attemptId: string }
  /**
   * The nonce is spent and this client cannot prove by what.
   *
   * The one case it cannot close, and it is left in flight on purpose: marking
   * it failed would invite a resend under a nonce that is gone, and marking it
   * confirmed would claim an outcome nobody read.
   */
  | { readonly kind: 'UNRESOLVED'; readonly attemptId: string; readonly detail: string };

export interface ReconcileOutcome {
  readonly resolutions: readonly AttemptResolution[];
  /** True while anything remains in flight, which is what blocks a new send. */
  readonly blocked: boolean;
}

export async function reconcileTransactions(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const scope = {
    chainId: deps.deployment.chainId,
    contractAddress: deps.deployment.contractAddress,
    signerAddress: deps.signerAddress,
  };

  const inFlight = await deps.transactions.listInFlight(scope);
  if (inFlight.length === 0) return { resolutions: [], blocked: false };

  // Read once for the whole sweep. Every nonce comparison below is against the
  // same answer, so two rows cannot be judged against a provider that moved
  // between them.
  const pendingNonce = await deps.receipts.pendingNonce(deps.signerAddress);

  const resolutions: AttemptResolution[] = [];
  for (const record of inFlight) {
    resolutions.push(await resolve(deps, record, pendingNonce));
  }

  return {
    resolutions,
    blocked: resolutions.some((resolution) => resolution.kind !== 'CONFIRMED'),
  };
}

async function resolve(
  deps: ReconcileDeps,
  record: TransactionRecord,
  pendingNonce: number | undefined,
): Promise<AttemptResolution> {
  if (record.hash !== undefined) {
    const outcome = await deps.receipts.outcome(record.hash);
    if (outcome === undefined) {
      // Not mined yet, or the provider did not answer. The two are the same
      // answer here and neither is a failure: `PENDING` is never `FAILED`.
      return { kind: 'STILL_PENDING', attemptId: record.attemptId };
    }

    await deps.transactions.advance(record.attemptId, 'CONFIRMED', {
      blockNumber: outcome.blockNumber,
      confirmedAt: outcome.confirmedAt,
      outcome: outcome.status,
      ...(outcome.revertReason === undefined ? {} : { failure: outcome.revertReason }),
    });
    return { kind: 'CONFIRMED', attemptId: record.attemptId, outcome: outcome.status };
  }

  if (record.nonce === undefined) {
    // Nothing was ever assigned, so nothing was sent — the only case this can
    // close in the negative, and it can only be closed because of the ordering
    // in `submitOperation`: the nonce is written before the hash, so its absence
    // is evidence rather than an inference.
    await deps.transactions.advance(record.attemptId, 'FAILED_RETRYABLE', {
      failure: 'no nonce was ever assigned, so nothing reached the chain',
    });
    return { kind: 'NEVER_SENT', attemptId: record.attemptId };
  }

  if (pendingNonce === undefined) {
    return {
      kind: 'UNRESOLVED',
      attemptId: record.attemptId,
      detail: 'the provider did not answer with a nonce, so nothing can be concluded yet',
    };
  }

  if (record.nonce >= pendingNonce) {
    // The chain has not consumed this nonce, so nothing under it was mined. The
    // attempt is retryable, and the same nonce will be assigned again.
    await deps.transactions.advance(record.attemptId, 'FAILED_RETRYABLE', {
      failure: `nonce ${record.nonce} is still unused at the provider`,
    });
    return { kind: 'NEVER_SENT', attemptId: record.attemptId };
  }

  // Spent, and no hash to check it against. Left in flight deliberately — see
  // the note on this module.
  return {
    kind: 'UNRESOLVED',
    attemptId: record.attemptId,
    detail:
      `nonce ${record.nonce} has been consumed on chain and this attempt has no hash, so what ` +
      'it did cannot be established from here',
  };
}
