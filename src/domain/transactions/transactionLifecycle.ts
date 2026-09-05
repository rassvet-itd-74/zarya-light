/**
 * What a write is doing, and what it may do next.
 *
 * The states `zarya-transactions` names, minus the outbox: `SIGNED` exists only
 * where raw signed payloads are persisted, and this client does not persist them
 * (see the note on `Signer`). Adding it later is a migration and a new edge, not
 * a rewrite — which is why the name is reserved here rather than reused.
 *
 * Every transition is persisted **before** it is exposed as status. A caller that
 * saw `BROADCAST` and then found the row still `SIGNING` after a crash would have
 * been told something the database never promised.
 */

export const TRANSACTION_STATES = [
  /** A call is built and the queue may take it. Nothing has been signed. */
  'READY',
  /** Handed to the signer. A crash here has produced nothing on chain. */
  'SIGNING',
  /**
   * Handed to the provider, hash not yet durable.
   *
   * The narrowest and worst window in the machine: the transaction may be in a
   * mempool under a nonce this client assigned, and the row cannot name it.
   * Recovery is by nonce, not by hash — see `INVARIANTS.md`.
   */
  'BROADCAST',
  /** The hash is durable. Waiting for a receipt, for as long as that takes. */
  'PENDING',
  /**
   * Mined, with a status this client has read. **Includes a revert** — a
   * reverted transaction is a confirmed outcome, and the receipt says so.
   */
  'CONFIRMED',
  /**
   * Not mined, and this client believes it can be retried under a fresh nonce.
   * Never a guess about the chain: only reached where the failure happened
   * before broadcast, or where the nonce is provably free again.
   */
  'FAILED_RETRYABLE',
  /**
   * It will never succeed. `InsufficientVotes` is the canonical case — zero
   * votes or quorum unmet leaves a voting unfinalized and every future attempt
   * reverts identically (`CONTRACT_DEFECTS.md`).
   */
  'FAILED_TERMINAL',
] as const;

export type TransactionState = (typeof TRANSACTION_STATES)[number];

export const isTransactionState = (value: string): value is TransactionState =>
  (TRANSACTION_STATES as readonly string[]).includes(value);

/**
 * The legal moves.
 *
 * Three absences carry rules:
 *
 * - **`PENDING` has no edge to a failure.** An unanswered receipt is an outage,
 *   not a verdict; the skill is explicit that `PENDING` is never `FAILED`. It
 *   waits, and reconciliation asks again. A stuck transaction is surfaced by how
 *   long it has been `PENDING`, not by moving it.
 * - **`CONFIRMED` is terminal, including on revert.** A revert is an answer. Re-
 *   submitting is a *new* transaction with its own row, never a rewind of this
 *   one, because the reverted attempt still consumed a nonce and still happened.
 * - **`BROADCAST` may only fail on evidence.** Once bytes have left, this client
 *   does not know whether they landed — so the edge to `FAILED_RETRYABLE` exists
 *   but is not reachable from the send path at all. It is taken by
 *   reconciliation, and only where the provider's pending nonce proves the
 *   nonce this row assigned is still unused, which means nothing under it was
 *   mined. A machine cannot express "on evidence"; what it can do is keep the
 *   edge out of every path that lacks it, which is why `submitOperation` never
 *   moves a row out of `BROADCAST` on an error.
 *
 *   The first version of this table omitted the edge entirely, on the reasoning
 *   that a broadcast is unknowable. That was too strong: a free nonce is a
 *   proof, and refusing to record it would have left provably-unsent rows in
 *   flight forever, blocking the queue.
 */
const TRANSITIONS: { readonly [S in TransactionState]: readonly TransactionState[] } = {
  READY: ['SIGNING', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'],
  SIGNING: ['BROADCAST', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'],
  BROADCAST: ['PENDING', 'FAILED_RETRYABLE'],
  PENDING: ['CONFIRMED'],
  CONFIRMED: [],
  FAILED_RETRYABLE: [],
  FAILED_TERMINAL: [],
};

export const canTransition = (from: TransactionState, to: TransactionState): boolean =>
  TRANSITIONS[from].includes(to);

/** A state with no moves left. A row here is history, never work. */
export const isTerminalTransactionState = (state: TransactionState): boolean =>
  TRANSITIONS[state].length === 0;

/**
 * States a crash can leave behind that recovery has to resolve.
 *
 * `READY` is not among them: nothing was attempted, so it is simply work. The
 * three here each mean "something may exist on chain that this row cannot fully
 * describe", and each is resolved differently — by nonce for the first two, by
 * hash for the third.
 */
export const isInFlight = (state: TransactionState): boolean =>
  state === 'SIGNING' || state === 'BROADCAST' || state === 'PENDING';

export class IllegalTransactionTransitionError extends Error {
  constructor(
    readonly from: TransactionState,
    readonly to: TransactionState,
  ) {
    super(`a transaction cannot move from ${from} to ${to}`);
    this.name = 'IllegalTransactionTransitionError';
  }
}

export function assertTransactionTransition(
  from: TransactionState,
  to: TransactionState,
): void {
  if (!canTransition(from, to)) throw new IllegalTransactionTransitionError(from, to);
}
