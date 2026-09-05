import type { OperationType } from '../intents/intent';
import type { IssuedTemplateState } from '../operations/issuedTemplate';
import type { ChainId, EvmAddress, OperationRef } from '../primitives';

/**
 * The trust anchor, made durable.
 *
 * `operationRef` is how ingestion recovers authoritative context instead of
 * reading it from an untrusted file, which makes this store load-bearing for
 * **correctness** and not merely for audit. Everything hard rule 4 promises
 * rests on a record being here: if the lookup comes back empty, the form has no
 * app-authored values and there is nothing to fall back to except the file — so
 * the honest answer is a rejection.
 *
 * ## `undefined` means "no such record", not "could not read"
 *
 * This inverts the convention every chain reader in this client follows, and it
 * has to. A chain read can fail without the answer being negative, so
 * `undefined` there means "we could not ask". A local store either has the row
 * or does not, and an I/O failure is not a third answer to that question — so
 * implementations **throw** on I/O failure and `undefined` is a fact. A store
 * that swallowed a disk error into `undefined` would turn a broken database into
 * a stream of forms reported as forgeries.
 */

/**
 * What the application knew when it issued a template.
 *
 * Two of these fields are maps the domain deliberately does not interpret. It
 * persists them and hands them back; the forms adapter owns their keys, because
 * `zarya.input.*` and `zarya.context.*` are form vocabulary and the domain is
 * not allowed to know a field name (`ARCHITECTURE.md`).
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
   * What the template printed in its context block, keyed by form field name.
   * Opaque here.
   *
   * It used to exist to be compared against what a returned file said, so a
   * disagreement could be reported without ever being used. That comparison is
   * gone — the context block is printed page text since 2026-09-06, so a
   * returned file carries no copy of it to disagree with. What remains is the
   * audit answer to "what did the document this member was sent actually say",
   * which is worth keeping and is the reason a reissued template is identical.
   */
  readonly displayedContext: Readonly<Record<string, string>>;
  /**
   * Wall-clock milliseconds, stamped by the adapter when the row was written.
   *
   * **Audit only, and never an input to a decision.** Chain time is the only
   * clock this client reasons with (hard rule 7, and the `Clock` port), so this
   * exists to order an audit trail a human reads and for nothing else. A
   * deadline computed from it would be exactly the bug `Clock` was introduced to
   * make impossible.
   */
  readonly recordedAt: number;
  /**
   * What the returned form turned out to be, once one has been imported.
   *
   * `undefined` until then, and never a placeholder: "no form has come back" and
   * "a form came back with an empty identity" must not be the same value.
   */
  readonly identityKey?: string;
  /** A vote's direction, stored beside the identity because it is not in it. */
  readonly voteDirection?: string;
  /** Digest of the file as received. */
  readonly formHash?: string;
}

/** A record being created. The state is fixed, so a caller cannot invent one. */
export type NewOperationRecord = Omit<OperationRecord, 'state' | 'recordedAt'>;

/**
 * Raised when `record` is called for a reference that already exists.
 *
 * A distinct error rather than an upsert: an `operationRef` collision means
 * either the id generator repeated itself or the same issuance ran twice, and
 * quietly overwriting the first would detach an already-emitted form from its
 * context. The uniqueness is enforced by the storage engine, not by an
 * application `if` — `zarya-persistence`: never rely on an application check for
 * race-sensitive uniqueness.
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
   * Persists a new operation in state `RECORDED`.
   *
   * The state is not a parameter. A record exists precisely because the
   * application decided to issue a template and has read everything it needs, so
   * there is no legitimate way to create one in `REQUESTED` or `EMITTED` — and
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
   * Operations in a given state, oldest first.
   *
   * For reconciliation on startup, which is the only caller that legitimately
   * asks "what was in flight" — and the reason it is scoped by deployment:
   * carrying work across a chain or address change would resume against a
   * history that never happened.
   */
  listByState(
    scope: { readonly chainId: ChainId; readonly contractAddress: EvmAddress },
    state: IssuedTemplateState,
  ): Promise<readonly OperationRecord[]>;

  /**
   * Operations on this deployment already carrying `identityKey`.
   *
   * The dedup question, and it is asked of the **store** rather than computed
   * over a listing because it has to see operations this session never touched:
   * a member who imported a form last week and reissued the template today has
   * two references and one intention.
   *
   * Returns every match, including the caller's own operation if it already has
   * the key. The caller compares references; deciding what a match *means* — a
   * duplicate, or a vote in the opposite direction — is domain reasoning and not
   * the store's.
   */
  findByIdentity(
    scope: { readonly chainId: ChainId; readonly contractAddress: EvmAddress },
    identityKey: string,
  ): Promise<readonly OperationRecord[]>;

  /**
   * Records what a returned form was, and moves the operation to `RETURNED`.
   *
   * **One call because it is one fact.** Writing the identity and the bytes in
   * one statement and advancing the state in another leaves two crash windows
   * that mean opposite things: a `RETURNED` row with no bytes cannot regenerate
   * its receipt, and an `EMITTED` row holding an identity would be re-imported
   * and deduped against itself. The state machine is still enforced, so this
   * refuses anything but `EMITTED → RETURNED`.
   *
   * The digest is computed by the implementation rather than passed in, so no
   * caller can record a hash that does not match the bytes beside it.
   *
   * @throws {UnknownOperationRefError} if the reference resolves to nothing.
   * @throws {IllegalTemplateTransitionError} if the operation is not `EMITTED`.
   */
  recordReturn(input: ReturnedFormRecord): Promise<void>;

  /**
   * The returned form's bytes, or `undefined` if no form has come back.
   *
   * Separate from `find` because these are large and almost nobody wants them:
   * a listing that carried a few hundred kilobytes per row would make
   * reconciliation expensive for no reason. The one caller is receipt stamping,
   * which is what makes a lost receipt regenerable without a chain write.
   */
  formBytes(operationRef: OperationRef): Promise<Uint8Array | undefined>;
}

export interface ReturnedFormRecord {
  readonly operationRef: OperationRef;
  readonly identityKey: string;
  /** Only for a vote. See {@link OperationRecord.voteDirection}. */
  readonly voteDirection?: string;
  /** The file exactly as it was received, for receipt regeneration in Phase 6. */
  readonly formBytes: Uint8Array;
}
