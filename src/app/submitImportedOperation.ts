import type { OperationStore } from '../domain/ports/OperationStore';
import type { ReturnedFormReader } from '../domain/ports/ReturnedFormReader';
import type { OperationRef } from '../domain/primitives';
import { type IntentFromFormDeps, intentFromForm } from './intentFromForm';
import { type SubmitDeps, type SubmitOutcome, submitOperation } from './submitOperation';

/**
 * Sending an operation that was already imported.
 *
 * This is the use case a button calls, and everything it does before reaching
 * `submitOperation` exists to answer one question: **what exactly is being sent,
 * and where did it come from?**
 *
 * ## The renderer names an operation and nothing else
 *
 * The request carries an `operationRef`. It does not carry an intent, calldata,
 * an address, or an amount — the untrusted UI chooses *which* stored operation to
 * send and has no way to influence *what* that operation is. Anything else would
 * put the renderer inside the allow-list the whole form pipeline exists to
 * enforce, one layer below where anyone would look for it.
 *
 * ## The intent is derived again, from the stored document
 *
 * Nothing persists an intent, so this re-reads the form bytes stored at import
 * and rebuilds it through the same parser, the same record binding and the same
 * builder that accepted it the first time. Two consequences worth stating:
 *
 * - The transaction is derived from the bytes the member actually returned,
 *   rather than from something held in memory between two user actions.
 * - The numerical scale is read at **submission**, one step closer to the mined
 *   block than at import. The residual window `FIELD_PLAN` describes — a decimals
 *   voting executing between the read and the mine — is narrowed, not closed.
 *
 * It also means a form that was importable can be refused here: the chain may
 * have become unreachable, or the cell's precision may have changed. That is the
 * honest answer rather than a surprise, and it happens before anything is signed.
 *
 * ## What it still does not do
 *
 * No preflight. Client preflight is UX and Solidity is the enforcement boundary
 * (hard rule 6), so a refusal here would be this client deciding governance. The
 * transaction goes and the chain answers.
 */

export interface SubmitImportedDeps extends SubmitDeps, IntentFromFormDeps {
  readonly store: OperationStore;
  readonly forms: ReturnedFormReader;
}

export interface SubmitImportedRequest {
  readonly operationRef: OperationRef;
}

export type SubmitImportedRefusalCode =
  /** No operation under that reference. */
  | 'UNKNOWN_OPERATION'
  /** Nothing has been imported for it, so there is nothing to send. */
  | 'NOT_IMPORTED'
  /** The record says a form came back and the bytes are not there. */
  | 'NO_STORED_FORM'
  /** The stored document no longer reads as the form it was. */
  | 'FORM_UNREADABLE'
  /** The record cannot back this form — wrong deployment, or an unbindable state. */
  | 'NOT_BINDABLE'
  /** A value the schema resolves from chain could not be read. Retryable. */
  | 'CHAIN_UNAVAILABLE'
  /** The stored form no longer makes a valid intent. */
  | 'INVALID_INTENT';

export type SubmitImportedOutcome =
  | SubmitOutcome
  | {
      readonly kind: 'NOT_SENT';
      readonly code: SubmitImportedRefusalCode;
      readonly message: string;
      readonly detail: readonly string[];
    };

export async function submitImportedOperation(
  deps: SubmitImportedDeps,
  request: SubmitImportedRequest,
): Promise<SubmitImportedOutcome> {
  const record = await deps.store.find(request.operationRef);
  if (record === undefined) {
    return notSent('UNKNOWN_OPERATION', 'This application has no record of that operation.');
  }

  if (record.state !== 'RETURNED') {
    // `EMITTED` means a form was handed out and never came back, which is the
    // ordinary case and not an error — it is simply nothing to send. Named so a
    // caller can say which of the two it is.
    return notSent(
      'NOT_IMPORTED',
      `No filled form has been imported for this operation — it is ${record.state}. Import the ` +
        'returned form before sending anything.',
    );
  }

  const bytes = await deps.store.formBytes(request.operationRef);
  if (bytes === undefined) {
    return notSent(
      'NO_STORED_FORM',
      'The record says a form was imported for this operation, but its bytes are not stored. ' +
        'Import the form again.',
    );
  }

  const read = await deps.forms.read(bytes);
  if (read.kind === 'UNREADABLE') {
    // Reachable if the schema version moved under a stored form. It parsed once,
    // so this is a statement about this build rather than about the document.
    return notSent(
      'FORM_UNREADABLE',
      'The stored form for this operation can no longer be read by this version of the ' +
        'application. Reissue and refill it.',
      read.problems.map((problem) => problem.message),
    );
  }

  const binding = read.form.bind(record, deps.deployment);
  if (binding.kind !== 'INPUT') {
    return notSent(
      'NOT_BINDABLE',
      'The stored form can no longer be bound to its record, so what it asks for cannot be ' +
        'established.',
      binding.problems.map((problem) => problem.message),
    );
  }

  const built = await intentFromForm(
    deps,
    binding.operationType,
    binding.input,
    binding.resolvedKeys,
  );
  if (built.kind === 'UNAVAILABLE') {
    return notSent('CHAIN_UNAVAILABLE', built.message);
  }
  if (built.kind === 'INVALID') {
    return notSent(
      'INVALID_INTENT',
      'The stored form no longer makes a valid operation.',
      built.problems.map((problem) => `${problem.field}: ${problem.message}`),
    );
  }

  // Everything above is a read. This is the line that sends.
  return await submitOperation(deps, {
    operationRef: request.operationRef,
    intent: built.intent,
  });
}

const notSent = (
  code: SubmitImportedRefusalCode,
  message: string,
  detail: readonly string[] = [],
): SubmitImportedOutcome => ({ kind: 'NOT_SENT', code, message, detail });
