import type { OperationType } from '../intents/intent';
import type { ChainId, EvmAddress, OperationRef } from '../primitives';

/**
 * Turning an operation into the document a member fills in.
 *
 * The domain declares this without knowing what a PDF is, and — more usefully —
 * without knowing a single field name. `zarya.context.*` and `zarya.input.*` are
 * form vocabulary owned by the forms adapter (`ARCHITECTURE.md`), so this port
 * passes **domain values** in and gets an opaque map back out.
 *
 * That opaque map is not laziness. `OperationStore.displayedContext` exists to be
 * compared against what a returned file says, so whatever issuance *printed* has
 * to be recorded exactly as printed — and the only component that knows what it
 * printed is the one that printed it. A second composition of the same values
 * somewhere else could differ, and a tamper check comparing two renderings would
 * report a forgery every time one of them changed.
 */

/** What a template prints in its context block, as domain values. */
export interface TemplateContext {
  readonly chainId: ChainId;
  readonly contractAddress: EvmAddress;
  /**
   * The contract's **own** identifier for the organ — `74.СОВ` — not one this
   * client composed. Absent for the operations that have no organ, which the
   * contract keys on `bool isCategorical` or on nothing at all.
   */
  readonly organIdentifier?: string;
  readonly votingId?: string;
}

/**
 * Which context values an operation's template needs.
 *
 * Asked rather than assumed, because the answer is derived from the field plan
 * and the field plan is form vocabulary. A use case that kept its own table of
 * "does this operation have an organ" would be a second list to fall out of step
 * with the first.
 */
export interface ContextRequirements {
  readonly organ: boolean;
  readonly votingId: boolean;
  /**
   * Values the record must carry that issuance **cannot know**, keyed by domain
   * key. **Empty for all eleven operations**, and kept because it once was not.
   *
   * `CREATE_NUMERICAL_VALUE_VOTING` was the exception: its `decimals` was bound
   * — "the scale the cell had when the template was issued" — while its `x` and
   * `y` were member-filled, so at issuance there was no cell to read a scale
   * from and the operation could not be issued at all. This reporting the key is
   * how that surfaced as a readable refusal rather than an invented scale.
   *
   * The schema now puts `decimals` in a third category, `resolved`, read from
   * the cell at import. So nothing is unavailable at issuance today, and a use
   * case that consults this is asking a question with a known answer — which is
   * the point. The next bound key added without an issuance-time source gets a
   * refusal instead of `undefined`.
   */
  readonly unavailableBoundKeys: readonly string[];
}

export interface IssuedTemplateFile {
  readonly bytes: Uint8Array;
  /** Every field written, for the audit trail. */
  readonly fieldNames: readonly string[];
  /**
   * Exactly what was printed in the context block, keyed by the adapter's own
   * field names. Opaque to the domain, stored verbatim, and compared — never
   * used — on the way back in.
   */
  readonly displayedContext: Readonly<Record<string, string>>;
}

export interface IssueTemplateCommand {
  readonly operationType: OperationType;
  readonly operationRef: OperationRef;
  readonly context: TemplateContext;
}

export interface TemplateWriter {
  requirements(operationType: OperationType): ContextRequirements;

  /**
   * Produces the document in memory. Writes nothing, signs nothing, reads no
   * chain — so a caller is free to record the operation before the bytes become
   * a file, which is the ordering `DECISIONS.md` requires.
   */
  issue(command: IssueTemplateCommand): Promise<IssuedTemplateFile>;
}
