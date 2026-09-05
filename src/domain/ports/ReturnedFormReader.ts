import type { IntentInput } from '../intents/fields';
import type { OperationType } from '../intents/intent';
import type { ChainId, EvmAddress, OperationRef } from '../primitives';
import type { OperationRecord } from './OperationStore';

/**
 * Reading a returned form, as the application service needs it.
 *
 * The mirror of `TemplateWriter`. Issuance orchestrates a port and so does
 * import; without this one the import use case bound straight to four modules in
 * `src/adapters/forms/`, which put a driving service on top of a driven adapter
 * and skipped the layer that is supposed to be between them.
 *
 * ## Why the port is this shape and not four methods
 *
 * The domain **may not know a field name** (`ARCHITECTURE.md`), so a port cannot
 * traffic in `zarya.input.*` maps. Everything that touches form vocabulary —
 * parsing, the schema, the prefix strip, the context comparison — stays behind
 * this interface, and what crosses is domain-shaped: an `OperationRef`, an
 * `OperationType`, an `IntentInput` keyed by domain key.
 *
 * It is two steps rather than one because the record has to be fetched in
 * between: the file says which operation it claims to be, the store answers what
 * that operation actually was, and only then can the two be reconciled. A single
 * call would have to reach into the store itself, which is the dependency this
 * port exists to keep out of the adapter.
 *
 * ## `field` is a display string, not vocabulary
 *
 * A `FormNote` may name the field it came from so a person can find it on the
 * page. That is opaque text travelling outward for display; nothing in the
 * domain reads it, matches on it, or maps it back.
 */

export interface FormNote {
  /** Stable enough for a caller to classify, never parsed for meaning. */
  readonly code: string;
  /** Where on the form, when that is known. Display only. */
  readonly field?: string;
  /** One line, safe to show a user. Never echoes an unbounded input back. */
  readonly message: string;
}

export interface FormDeploymentScope {
  readonly chainId: ChainId;
  readonly contractAddress: EvmAddress;
}

export type FormBinding =
  | {
      readonly kind: 'INPUT';
      readonly operationType: OperationType;
      /**
       * The member-filled and app-recorded halves, merged and keyed by domain
       * key.
       *
       * **Incomplete by design** where {@link resolvedKeys} is non-empty: those
       * come from a chain read the caller makes, because this port is pure and a
       * form's own copy of such a value must never be used.
       */
      readonly input: IntentInput;
      /** Domain keys the caller must read from chain before building an intent. */
      readonly resolvedKeys: readonly string[];
      /** Disagreements between file and record. Reported, never used. */
      readonly warnings: readonly FormNote[];
    }
  /** The record cannot back this form at all — wrong deployment, or never emitted. */
  | { readonly kind: 'NOT_BINDABLE'; readonly problems: readonly FormNote[] }
  /** The form's own fields do not satisfy the schema. */
  | { readonly kind: 'REFUSED'; readonly problems: readonly FormNote[] };

export interface ReturnedForm {
  /** Which operation the file claims to be. Confirmed by the store, never trusted. */
  readonly operationRef: OperationRef;

  /**
   * Reconciles the file against the record it named.
   *
   * Synchronous: every judgement here is structural, so a binding result is
   * reproducible and a failure is never an outage.
   */
  bind(record: OperationRecord, scope: FormDeploymentScope): FormBinding;
}

export type ReadFormResult =
  | {
      readonly kind: 'FORM';
      readonly form: ReturnedForm;
      /**
       * Things worth showing about a file that was nonetheless readable — an
       * appearance that disagrees with its stored value. Tamper evidence, and
       * never a reason to withhold the form.
       */
      readonly disclosures: readonly FormNote[];
    }
  | { readonly kind: 'UNREADABLE'; readonly problems: readonly FormNote[] };

export interface ReturnedFormReader {
  /**
   * Reads bytes far enough to say which operation they claim to be.
   *
   * **Never throws** — every failure is a result value, because a caller
   * deciding whether to import a file must not have to tell an exception from an
   * answer.
   */
  read(bytes: Uint8Array): Promise<ReadFormResult>;
}
