import { canBindReturnedForm } from '../../domain/operations/issuedTemplate';
import type { OperationRecord } from '../../domain/ports/OperationStore';
import type { ChainId, EvmAddress } from '../../domain/primitives';
import type { IssuedOperation } from './assembleFormInput';

/**
 * A stored operation into the shape ingestion assembles against.
 *
 * This is where the loop closes. Issuance records an operation and hands over a
 * file; ingestion reads the file's `operationRef`, finds the record, and asks
 * this for the app-authored half. Until the store existed, `IssuedOperation` was
 * something a test invented — every issued form was bound to a record that did
 * not exist.
 *
 * The mapping is small and the checks around it are the point.
 */

export type BindingRefusalCode =
  /** The record belongs to a different chain or contract. */
  | 'WRONG_DEPLOYMENT'
  /** The record exists but no file was ever handed over under it. */
  | 'NOT_EMITTED';

export type BindingResult =
  | { readonly kind: 'BOUND'; readonly issued: IssuedOperation }
  | { readonly kind: 'REFUSED'; readonly code: BindingRefusalCode; readonly message: string };

export interface DeploymentScope {
  readonly chainId: ChainId;
  readonly contractAddress: EvmAddress;
}

/**
 * Binds a record to the current deployment, or refuses.
 *
 * ## The deployment check is not defensive padding
 *
 * `assembleFormInput` never reads the chain id or the contract from the returned
 * file — they are display fields, compared and then ignored — so the *record* is
 * the only thing that says which deployment an operation belongs to. Without a
 * check here, repointing the application at the other deployment and importing
 * an old form would resolve its reference, recover its context, and build a
 * perfectly valid intent **for the wrong contract**. Two incompatible
 * deployments exist (`DEPLOYMENT.md`), so this is a reachable state and not a
 * hypothetical.
 *
 * The scope lives in the record for exactly this reason rather than in global
 * configuration, and comparing them is what makes that worth anything.
 *
 * ## Why `NOT_EMITTED` is separate from "unknown reference"
 *
 * A form quoting a reference that never reached `EMITTED` did not come from this
 * application: no file was handed over under it. That is a different fact from a
 * reference nobody has ever seen, and both are refusals — but only one of them
 * suggests a database that lost rows.
 *
 * A record in `RETURNED` or `SUPERSEDED` **is** bindable, deliberately. A second
 * copy of an already-imported form has to resolve to the completed operation so
 * dedup can call it a duplicate; resolving to nothing would let it be treated as
 * unbound.
 */
export function bindOperation(record: OperationRecord, scope: DeploymentScope): BindingResult {
  if (
    record.chainId !== scope.chainId ||
    record.contractAddress.toLowerCase() !== scope.contractAddress.toLowerCase()
  ) {
    return {
      kind: 'REFUSED',
      code: 'WRONG_DEPLOYMENT',
      message:
        'This form was issued against a different contract or network than the one this application is connected to. It cannot be submitted here.',
    };
  }

  if (!canBindReturnedForm(record.state)) {
    return {
      kind: 'REFUSED',
      code: 'NOT_EMITTED',
      message:
        'This form quotes an operation for which no file was ever issued, so it did not come from this application.',
    };
  }

  return {
    kind: 'BOUND',
    issued: {
      operationRef: record.operationRef,
      operationType: record.operationType,
      values: record.boundValues,
      context: record.displayedContext,
    },
  };
}
