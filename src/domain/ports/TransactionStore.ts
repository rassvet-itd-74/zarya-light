import type { TransactionState } from '../transactions/transactionLifecycle';
import type { ChainId, EvmAddress, OperationRef } from '../primitives';

/**
 * The durable record of every write this client has attempted.
 *
 * It exists for **recovery**, not for audit — audit is a consequence. After a
 * crash the only thing that says a transaction may be in a mempool is a row
 * here, and the only way to find out what happened to it is the nonce that row
 * assigned. Losing this table does not lose money, but it loses the ability to
 * tell "never sent" from "sent and unknown", which is the distinction the whole
 * lifecycle is built around.
 *
 * ## Scoped to a deployment and a signer
 *
 * A nonce means nothing without both. The same number is a different transaction
 * on another chain, and a different one for another wallet — so every query that
 * reasons about nonces takes the pair, and carrying a row across either would
 * resume against a history that never happened.
 */

export interface TransactionRecord {
  /** Which operation this write is for. One operation may have several attempts. */
  readonly operationRef: OperationRef;
  /** Unique per attempt. An operation resubmitted after a revert gets a new one. */
  readonly attemptId: string;
  readonly chainId: ChainId;
  readonly contractAddress: EvmAddress;
  readonly signerAddress: EvmAddress;
  readonly state: TransactionState;
  /** The calldata sent, kept so an attempt can be described without rebuilding it. */
  readonly data: `0x${string}`;
  /**
   * `undefined` until the provider names it.
   *
   * The gap between broadcast and this being durable is crash window three, and
   * it is why {@link nonce} exists separately: a row with a nonce and no hash is
   * recoverable, a row with neither was never sent.
   */
  readonly hash?: `0x${string}`;
  /** `undefined` until the provider assigns it. Read back, never chosen locally. */
  readonly nonce?: number;
  /** Block the receipt came from. Audit and staleness only. */
  readonly blockNumber?: string;
  /**
   * The confirming block's timestamp, in seconds. Chain time.
   *
   * Stored so a receipt can be stamped and re-stamped with no chain access.
   */
  readonly confirmedAt?: number;
  /** `SUCCESS` or `REVERTED`, once a receipt has been read. */
  readonly outcome?: string;
  /** Decoded revert name, or a classified failure. Never a stack trace. */
  readonly failure?: string;
  /** Wall-clock milliseconds. **Audit only** — chain time is the only clock decisions use. */
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A new attempt. The state is fixed, so a caller cannot claim one already sent. */
export type NewTransactionRecord = Omit<
  TransactionRecord,
  | 'state' | 'createdAt' | 'updatedAt' | 'hash' | 'nonce' | 'blockNumber' | 'confirmedAt' | 'outcome' | 'failure'
>;

export class DuplicateAttemptError extends Error {
  constructor(readonly attemptId: string) {
    super(`a transaction attempt is already recorded under ${attemptId}`);
    this.name = 'DuplicateAttemptError';
  }
}

export class UnknownAttemptError extends Error {
  constructor(readonly attemptId: string) {
    super(`no transaction attempt is recorded under ${attemptId}`);
    this.name = 'UnknownAttemptError';
  }
}

export interface SignerScope {
  readonly chainId: ChainId;
  readonly contractAddress: EvmAddress;
  readonly signerAddress: EvmAddress;
}

export interface TransactionStore {
  /**
   * Persists a new attempt in `READY`.
   *
   * @throws {DuplicateAttemptError}
   */
  open(record: NewTransactionRecord): Promise<void>;

  find(attemptId: string): Promise<TransactionRecord | undefined>;

  /**
   * Moves an attempt to `state`, refusing an illegal move, and records whatever
   * that transition made durable.
   *
   * The fields travel **with** the transition rather than in a separate write,
   * because each one only becomes true at a specific edge: a hash at
   * `BROADCAST → PENDING`, an outcome at `PENDING → CONFIRMED`. Writing them
   * apart would allow a row holding a hash while still claiming it had not
   * broadcast.
   *
   * @throws {UnknownAttemptError}
   * @throws {IllegalTransactionTransitionError}
   */
  advance(attemptId: string, state: TransactionState, learned?: LearnedFacts): Promise<void>;

  /**
   * Every attempt for this signer on this deployment that a crash could have
   * left mid-flight — `SIGNING`, `BROADCAST` or `PENDING`, oldest first.
   *
   * The startup question, and the reason this port exists. Reconciliation reads
   * this before the queue is allowed to send anything, because sending under a
   * nonce an unrecovered attempt already used is how a client replaces its own
   * transaction without meaning to.
   */
  listInFlight(scope: SignerScope): Promise<readonly TransactionRecord[]>;

  /**
   * The highest nonce this client has recorded for the signer, or `undefined`.
   *
   * Compared against the provider's pending nonce rather than trusted over it —
   * this says what *this client* believes it sent, and the two disagreeing is
   * exactly the condition recovery has to notice.
   */
  highestNonce(scope: SignerScope): Promise<number | undefined>;
}

/** What a transition made durable. Each field belongs to one edge; see `advance`. */
export interface LearnedFacts {
  readonly hash?: `0x${string}`;
  readonly nonce?: number;
  readonly blockNumber?: string;
  readonly confirmedAt?: number;
  readonly outcome?: string;
  readonly failure?: string;
}
