import type { OperationType } from '../intents/intent';
import type { IssuedTemplateState } from '../operations/issuedTemplate';
import type { ChainId, EvmAddress, OperationRef } from '../primitives';

/**
 * Where ingestion recovers app-authored context instead of trusting the file, so
 * this store is load-bearing for correctness rather than audit.
 *
 * **`undefined` means "no such record", not "could not read"** — the opposite of
 * every chain reader here. Implementations throw on I/O failure; a store that
 * swallowed a disk error would turn a broken database into a stream of forms
 * reported as forgeries.
 */

/**
 * What the application knew when it issued a template. The two maps are opaque
 * here — field names are form vocabulary and the domain may not know them.
 */
export interface OperationRecord {
  readonly operationRef: OperationRef;
  readonly operationType: OperationType;
  /**
   * The deployment this operation belongs to. Part of the record rather than
   * global configuration, because a form issued against one deployment must
   * never bind against another — and the app can be repointed between the two.
   */
  readonly chainId: ChainId;
  readonly contractAddress: EvmAddress;
  readonly state: IssuedTemplateState;
  /**
   * The values a form is **not** allowed to supply, keyed by domain key —
   * `FIELD_PLAN[type].bound`. Opaque here.
   */
  readonly boundValues: Readonly<Record<string, string>>;
  /**
   * What the template printed, keyed by form field name. Audit only — the
   * returned file carries no copy of it to compare against.
   */
  readonly displayedContext: Readonly<Record<string, string>>;
  /** Wall clock, audit only. Never an input to a decision — chain time is (hard rule 7). */
  readonly recordedAt: number;
  /** `undefined` until a form comes back, never a placeholder. */
  readonly identityKey?: string;
  /** A vote's direction, stored beside the identity because it is not in it. */
  readonly voteDirection?: string;
  /** Digest of the file as received. */
  readonly formHash?: string;
}

/** A record being created. The state is fixed, so a caller cannot invent one. */
export type NewOperationRecord = Omit<OperationRecord, 'state' | 'recordedAt'>;

/**
 * An error rather than an upsert: overwriting would detach an already-emitted
 * form from its context. Uniqueness is enforced by the engine, not by an `if`.
 */
export class DuplicateOperationRefError extends Error {
  constructor(readonly operationRef: OperationRef) {
    super(`an operation is already recorded under ${operationRef}`);
    this.name = 'DuplicateOperationRefError';
  }
}

export class UnknownOperationRefError extends Error {
  constructor(readonly operationRef: OperationRef) {
    super(`no operation is recorded under ${operationRef}`);
    this.name = 'UnknownOperationRefError';
  }
}

export interface OperationStore {
  /**
   * Persists a new operation in `RECORDED`. The state is not a parameter —
   * creating one in `EMITTED` would claim a file was handed over before it was.
   *
   * @throws {DuplicateOperationRefError}
   */
  record(record: NewOperationRecord): Promise<void>;

  /** `undefined` means no such operation. See the note on this module. */
  find(operationRef: OperationRef): Promise<OperationRecord | undefined>;

  /**
   * Moves an operation to `state`, refusing an illegal move.
   *
   * @throws {UnknownOperationRefError} if the reference resolves to nothing.
   * @throws {IllegalTemplateTransitionError} if the machine forbids the move.
   */
  advance(operationRef: OperationRef, state: IssuedTemplateState): Promise<void>;

  /**
   * Operations in a given state, oldest first, for startup reconciliation.
   * Scoped by deployment: resuming across an address change would replay against
   * a history that never happened.
   */
  listByState(
    scope: { readonly chainId: ChainId; readonly contractAddress: EvmAddress },
    state: IssuedTemplateState,
  ): Promise<readonly OperationRecord[]>;

  /**
   * Operations already carrying `identityKey`, asked of the store so it sees
   * ones this session never touched. Returns every match including the caller's
   * own; what a match *means* is domain reasoning, not the store's.
   */
  findByIdentity(
    scope: { readonly chainId: ChainId; readonly contractAddress: EvmAddress },
    identityKey: string,
  ): Promise<readonly OperationRecord[]>;

  /**
   * Identity, bytes and state in **one call**, because splitting them leaves two
   * crash windows that mean opposite things: a `RETURNED` row with no bytes
   * cannot regenerate its receipt, and an `EMITTED` row holding an identity
   * dedups against itself. The digest is computed here so no caller can record a
   * hash that does not match the bytes.
   *
   * @throws {UnknownOperationRefError} if the reference resolves to nothing.
   * @throws {IllegalTemplateTransitionError} if the operation is not `EMITTED`.
   */
  recordReturn(input: ReturnedFormRecord): Promise<void>;

  /**
   * The returned form's bytes. Separate from `find` because they are hundreds of
   * kilobytes and the only caller is receipt stamping.
   */
  formBytes(operationRef: OperationRef): Promise<Uint8Array | undefined>;
}

export interface ReturnedFormRecord {
  readonly operationRef: OperationRef;
  readonly identityKey: string;
  /** Only for a vote. See {@link OperationRecord.voteDirection}. */
  readonly voteDirection?: string;
  /** The file exactly as received, for receipt regeneration. */
  readonly formBytes: Uint8Array;
}
