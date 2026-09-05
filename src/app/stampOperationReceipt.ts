import type { FileSink } from '../domain/ports/FileSink';
import type { OperationStore } from '../domain/ports/OperationStore';
import type { ReceiptStamper } from '../domain/ports/ReceiptStamper';
import type { TransactionStore } from '../domain/ports/TransactionStore';
import type { OperationRef, UnixSeconds } from '../domain/primitives';

/**
 * Producing the receipt for a confirmed transaction.
 *
 * ## On confirmation, never on broadcast
 *
 * Hard rule 5, and the whole shape of this use case follows from it: the only
 * attempts it will stamp are `CONFIRMED` ones. A form stamped for a transaction
 * still in a mempool becomes a false record the moment it is printed, and a
 * printed false record cannot be recalled.
 *
 * **A reverted transaction is stamped too.** It confirmed; the receipt says
 * `REVERTED`. Refusing to stamp one would leave a member with no document for an
 * outcome that definitely happened — and absence of a receipt means "outcome
 * unknown", which would then be a lie.
 *
 * ## No chain access at all
 *
 * Everything in the stamp comes from the local record: the form bytes stored at
 * import, and the transaction record written when the receipt was read. That is
 * what makes stamping **re-runnable** — a lost or damaged receipt is regenerated
 * without touching the chain, and regenerating it twice produces the same bytes.
 *
 * There is deliberately **no `Clock` here at all**. The first version took one,
 * to read the confirming block's time — which would have meant a receipt could
 * not be regenerated offline, contradicting the invariant this module quotes.
 * The confirmation time is read once, when the receipt is, and stored with the
 * attempt; a workstation clock has no route to this page.
 */

export interface StampReceiptDeps {
  readonly operations: OperationStore;
  readonly transactions: TransactionStore;
  readonly receipts: ReceiptStamper;
  readonly files: FileSink;
}

export interface StampReceiptRequest {
  readonly operationRef: OperationRef;
  readonly attemptId: string;
  /** Already chosen by the user, in a dialog main owns. */
  readonly targetPath: string;
}

export type StampRefusalCode =
  /** No attempt under that id. */
  | 'UNKNOWN_ATTEMPT'
  /** The attempt is not this operation's. */
  | 'ATTEMPT_MISMATCH'
  /** Not confirmed. A receipt for a pending transaction would be a false record. */
  | 'NOT_CONFIRMED'
  /** No returned form is stored, so there is nothing to stamp. */
  | 'NO_STORED_FORM'
  /** The chain time for the confirming block could not be read. */
  | 'NO_CONFIRMATION_TIME';

export type StampReceiptOutcome =
  | {
      readonly kind: 'STAMPED';
      readonly path: string;
      /** `SUCCESS` or `REVERTED` — the transaction's outcome, not the proposal's. */
      readonly status: string;
      readonly txHash: string;
      /** How many facts the stamp states. Six, and asserted against the schema. */
      readonly factCount: number;
    }
  | { readonly kind: 'REFUSED'; readonly code: StampRefusalCode; readonly message: string };

export async function stampOperationReceipt(
  deps: StampReceiptDeps,
  request: StampReceiptRequest,
): Promise<StampReceiptOutcome> {
  const attempt = await deps.transactions.find(request.attemptId);
  if (attempt === undefined) {
    return refused('UNKNOWN_ATTEMPT', 'No transaction is recorded under that attempt.');
  }
  if (attempt.operationRef !== request.operationRef) {
    // Checked rather than assumed: stamping one operation's form with another's
    // transaction would produce a document that is internally consistent and
    // completely wrong.
    return refused(
      'ATTEMPT_MISMATCH',
      'That transaction belongs to a different operation, so its receipt cannot be stamped onto ' +
        'this form.',
    );
  }

  if (attempt.state !== 'CONFIRMED' || attempt.hash === undefined || attempt.outcome === undefined) {
    // Hard rule 5. `PENDING` is not a failure and this is not a complaint — it
    // is "not yet", and the caller is expected to come back.
    return refused(
      'NOT_CONFIRMED',
      'This transaction has not confirmed, so there is no outcome to record. A receipt is stamped ' +
        'on confirmation, never on sending.',
    );
  }

  const form = await deps.operations.formBytes(request.operationRef);
  if (form === undefined) {
    return refused(
      'NO_STORED_FORM',
      'No returned form is stored for this operation, so there is nothing to stamp. A receipt is a ' +
        'rendering of the form that was imported.',
    );
  }

  const confirmedAt = attempt.confirmedAt;
  if (confirmedAt === undefined) {
    // Only reachable for a row confirmed by an older build. A receipt must not
    // carry a workstation clock, so the honest answer is to re-read the receipt
    // rather than to date the document from here.
    return refused(
      'NO_CONFIRMATION_TIME',
      'This transaction was recorded without the chain time of its block, so the receipt has no ' +
        'honest date. Reconcile it again to read one.',
    );
  }

  const stamped = await deps.receipts.stamp(form, {
    txHash: attempt.hash,
    status: attempt.outcome,
    blockNumber: attempt.blockNumber ?? '',
    chainId: attempt.chainId,
    confirmedAt: confirmedAt as UnixSeconds,
    signer: attempt.signerAddress,
  });

  await deps.files.write(request.targetPath, stamped.bytes);

  return {
    kind: 'STAMPED',
    path: request.targetPath,
    status: attempt.outcome,
    txHash: attempt.hash,
    factCount: stamped.drawnFacts.length,
  };
}

const refused = (code: StampRefusalCode, message: string): StampReceiptOutcome => ({
  kind: 'REFUSED',
  code,
  message,
});
