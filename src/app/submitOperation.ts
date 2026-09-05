import { type GovernanceIntent } from '../domain/intents/intent';
import { callsForIntent } from '../domain/intents/intentCalls';
import type { IdGenerator } from '../domain/ports/IdGenerator';
import type { ReceiptReader } from '../domain/ports/ReceiptReader';
import type { Signer } from '../domain/ports/Signer';
import type { TransactionStore } from '../domain/ports/TransactionStore';
import type { WriteCallEncoder } from '../domain/ports/WriteCallEncoder';
import type { ChainId, EvmAddress, OperationRef } from '../domain/primitives';

/**
 * Sending one operation's transactions, in order, one at a time.
 *
 * **This is the only thing in the application that broadcasts.** Hard rule 1
 * says never send a transaction unless explicitly asked, so nothing calls this
 * on a timer, on startup, or on reconnect — it runs when a person asks for it
 * and not otherwise.
 *
 * ## Serialized, and why that is not a performance decision
 *
 * One active write per signer (hard rule 8). Two writes from one wallet in
 * flight together means two nonces assigned from a provider's view that neither
 * call can see, and the loser is silently replaced rather than failed. The
 * member wallet and the executor wallet are separate, so they never contend and
 * nothing is lost by refusing to parallelize.
 *
 * The guard is not a lock in memory. It asks the **store** what is in flight,
 * because the case that matters is a previous process that crashed mid-send —
 * an in-memory flag would be empty exactly when it needed to say no.
 *
 * ## `CONFIGURE_ORGAN_THRESHOLDS` is three transactions and this is where it hurts
 *
 * `callsForIntent` expands it, the order is deliberate (`CONTRACT_DEFECTS.md`),
 * and there is no atomicity across the three. A failure after the first leaves
 * an organ **partly configured**, which is a real governance state and not a
 * rollback this client can perform. Each call gets its own attempt row so the
 * record says exactly how far it got, and the outcome names it.
 *
 * ## What it does not do
 *
 * It does not wait for receipts. A transaction reaches `PENDING` and stays there
 * until reconciliation reads it, because how long to wait is a policy and a use
 * case that blocked on a mempool would have no way to distinguish a slow block
 * from a hung provider. `PENDING` is never a failure.
 */

export interface SubmitDeps {
  readonly signer: Signer;
  readonly receipts: ReceiptReader;
  readonly encoder: WriteCallEncoder;
  readonly transactions: TransactionStore;
  readonly ids: IdGenerator;
  readonly deployment: {
    readonly chainId: ChainId;
    readonly contractAddress: EvmAddress;
  };
}

export interface SubmitRequest {
  readonly operationRef: OperationRef;
  readonly intent: GovernanceIntent;
}

export type SubmitRefusalCode =
  /** Something this signer sent is unresolved. Recovery first; nothing was sent. */
  | 'WRITES_IN_FLIGHT'
  /** The signer is for another chain than the one configured. */
  | 'WRONG_CHAIN'
  /** A call could not be encoded. The detail says whether that is retryable. */
  | 'NOT_ENCODABLE'
  /** The provider would not accept a transaction. Nothing reached the chain.  */
  | 'SUBMISSION_FAILED';

export interface SubmittedAttempt {
  readonly attemptId: string;
  readonly hash: `0x${string}`;
  readonly nonce: number;
}

export type SubmitOutcome =
  | {
      readonly kind: 'SUBMITTED';
      /** In send order. More than one only for a threshold configuration. */
      readonly attempts: readonly SubmittedAttempt[];
    }
  | {
      /**
       * Some of a multi-call operation reached the chain and then one did not.
       * Named rather than folded into a refusal, because what already landed
       * cannot be undone and a caller must not present this as "nothing
       * happened".
       */
      readonly kind: 'PARTIALLY_SUBMITTED';
      readonly attempts: readonly SubmittedAttempt[];
      readonly code: SubmitRefusalCode;
      readonly message: string;
    }
  | {
      readonly kind: 'REFUSED';
      readonly code: SubmitRefusalCode;
      readonly message: string;
    };

export async function submitOperation(
  deps: SubmitDeps,
  request: SubmitRequest,
): Promise<SubmitOutcome> {
  const identity = deps.signer.identity();
  if (identity.chainId !== deps.deployment.chainId) {
    // Fails closed. A signer configured for another chain would produce a
    // perfectly valid transaction for the wrong network.
    return refused(
      'WRONG_CHAIN',
      `this signer is configured for chain ${String(identity.chainId)} and the application is ` +
        `connected to ${String(deps.deployment.chainId)}`,
    );
  }

  const scope = {
    chainId: deps.deployment.chainId,
    contractAddress: deps.deployment.contractAddress,
    signerAddress: identity.address,
  };

  const inFlight = await deps.transactions.listInFlight(scope);
  if (inFlight.length > 0) {
    // Asked of the store, not of memory: the case this exists for is a process
    // that died mid-send, and an in-memory flag would be empty then.
    return refused(
      'WRITES_IN_FLIGHT',
      `${inFlight.length} transaction(s) from this wallet are unresolved. Reconcile them before ` +
        'sending anything else, or a new transaction may replace one already in a mempool.',
    );
  }

  const calls = callsForIntent(request.intent);
  const sent: SubmittedAttempt[] = [];

  for (const call of calls) {
    const encoded = await deps.encoder.encode(call);
    if (encoded.kind === 'UNAVAILABLE') {
      return partial(sent, 'NOT_ENCODABLE', `${call.fn}: ${encoded.detail}`);
    }

    const attemptId = deps.ids.newOperationRef();
    // Durable before anything is signed. This is crash window one: a row in
    // `READY` with no nonce means nothing was sent, which is exactly what a
    // recovery needs to be able to conclude.
    await deps.transactions.open({
      attemptId,
      operationRef: request.operationRef,
      chainId: scope.chainId,
      contractAddress: scope.contractAddress,
      signerAddress: identity.address,
      data: encoded.data,
    });

    await deps.transactions.advance(attemptId, 'SIGNING');

    let submitted;
    try {
      submitted = await deps.signer.submit({
        to: deps.deployment.contractAddress,
        data: encoded.data,
      });
    } catch (error) {
      // Ambiguous by nature: the provider may have accepted the transaction and
      // failed to answer. So the row is **not** marked failed — it stays
      // `SIGNING`, which reconciliation reads as "resolve this by nonce". The
      // alternative, calling it retryable here, is how a client sends the same
      // governance action twice.
      return partial(
        sent,
        'SUBMISSION_FAILED',
        `${call.fn}: ${error instanceof Error ? error.message : 'the provider did not answer'}`,
      );
    }

    // Two edges, in this order, and never merged: `BROADCAST` records that bytes
    // left, and `PENDING` records that this client knows their hash. Between
    // them is crash window three, and it is narrow because it is two statements
    // and no I/O.
    await deps.transactions.advance(attemptId, 'BROADCAST', { nonce: submitted.nonce });
    await deps.transactions.advance(attemptId, 'PENDING', { hash: submitted.hash });

    sent.push({ attemptId, hash: submitted.hash, nonce: submitted.nonce });

    // Serialized within the operation too. The three threshold setters are
    // order-dependent, so the second must not be assigned a nonce before the
    // first is known to have one.
  }

  return { kind: 'SUBMITTED', attempts: sent };
}

const refused = (code: SubmitRefusalCode, message: string): SubmitOutcome => ({
  kind: 'REFUSED',
  code,
  message,
});

/**
 * A failure part-way through a multi-call operation.
 *
 * Collapses to a plain refusal when nothing was sent, so a caller does not have
 * to special-case an empty list — but the moment one transaction has left, the
 * answer changes shape, because "nothing happened" would be false.
 */
const partial = (
  sent: readonly SubmittedAttempt[],
  code: SubmitRefusalCode,
  message: string,
): SubmitOutcome =>
  sent.length === 0
    ? refused(code, message)
    : { kind: 'PARTIALLY_SUBMITTED', attempts: sent, code, message };
