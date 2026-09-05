import type { OperationType } from '../domain/intents/intent';
import { type PartyOrganTriple, scopeOf } from '../domain/organs/partyOrgan';
import { subjectCodeOf } from '../domain/organs/regions';
import type { FileSink } from '../domain/ports/FileSink';
import type { IdGenerator } from '../domain/ports/IdGenerator';
import type { OperationStore } from '../domain/ports/OperationStore';
import { OrganIdentifierMismatchError, type OrganResolver } from '../domain/ports/OrganResolver';
import type { TemplateWriter } from '../domain/ports/TemplateWriter';
import type { ChainId, EvmAddress, OperationRef } from '../domain/primitives';

/**
 * Issuing a template: the first use case in this application that changes
 * anything.
 *
 * Everything it composes already existed and was reachable only from tests —
 * the operation store, the id generator, the organ resolver, the template
 * writer. What this adds is the **order**, which is the part that carries a
 * correctness rule and the part no unit test of a component could hold.
 *
 * ## The order, and why it is this order
 *
 * ```text
 * resolve the organ  ->  build the bytes  ->  record  ->  write the file  ->  EMITTED
 * ```
 *
 * **Resolve first**, because the organ identifier printed on a governance
 * document has to be the contract's own rendering of the triple, verified against
 * it, rather than one this client composed. A wrong region ordinal resolves to a
 * *different real region* and nothing downstream would notice
 * (`CONTRACT_DEFECTS.md`).
 *
 * **Build the bytes before recording**, because the record has to store what the
 * template actually printed — that map is the only thing a tamper check can
 * compare a returned file against, and a second composition of the same values
 * could differ.
 *
 * **Record before writing the file.** This is the ordering `DECISIONS.md`
 * requires and the reason `OperationStore` exists: an `operationRef` printed on a
 * file that no row resolves is a form the application cannot bind, so ingestion
 * would have to fall back to the file's own values — exactly what hard rule 4
 * forbids. Bytes in memory are not an emitted document; a file on disk is.
 *
 * **`EMITTED` last.** If the write fails, the row stays `RECORDED`, which is
 * precisely what the state machine means by it: recorded, not handed over. That
 * is a crash window working as designed rather than a case to guard against.
 */

export interface IssueTemplateDeps {
  readonly organs: OrganResolver;
  readonly store: OperationStore;
  readonly templates: TemplateWriter;
  readonly files: FileSink;
  readonly ids: IdGenerator;
  /**
   * Which deployment this operation belongs to.
   *
   * Recorded on the row rather than read from configuration at import time,
   * because the application can be repointed between two incompatible
   * deployments and the row is then the only thing that says which one a form was
   * issued against. See `boundOperation.ts`.
   */
  readonly deployment: {
    readonly chainId: ChainId;
    readonly contractAddress: EvmAddress;
  };
}

export interface IssueTemplateRequest {
  readonly operationType: OperationType;
  /** Required for the operations whose context carries one. */
  readonly organ?: PartyOrganTriple;
  /** Required for `CAST_VOTE` and meaningless elsewhere. */
  readonly votingId?: string;
  /** Already chosen by the user. See `FileSink`. */
  readonly targetPath: string;
}

export type IssueRefusalCode =
  /** The operation's context needs an organ and none was given. */
  | 'ORGAN_REQUIRED'
  /** An organ was given for an operation that has none — refused rather than ignored. */
  | 'ORGAN_NOT_APPLICABLE'
  | 'VOTING_ID_REQUIRED'
  /** The contract renders this triple differently from the local mirror. */
  | 'ORGAN_MISMATCH'
  /**
   * The record would need a value issuance cannot know. **Unreachable today**,
   * and kept as a guard: `CREATE_NUMERICAL_VALUE_VOTING` used to reach it,
   * because its `decimals` was bound to a cell the member had not chosen yet.
   * The schema now resolves that from the cell at import, and
   * `formSchema.test.ts` asserts every bound key has an issuance-time source —
   * so this arm fires only if that invariant is broken. See
   * `ContextRequirements`.
   */
  | 'BOUND_VALUE_UNAVAILABLE';

export type IssueTemplateOutcome =
  | {
      readonly kind: 'ISSUED';
      readonly operationRef: OperationRef;
      readonly path: string;
      readonly organIdentifier?: string;
      readonly fieldCount: number;
    }
  /**
   * Refused before anything was recorded or written.
   *
   * Every arm of this is reached before `record`, deliberately: a refusal leaves
   * no row and no file, so nothing has to be cleaned up and the audit trail has
   * no entries for operations that never happened.
   */
  | {
      readonly kind: 'REFUSED';
      readonly code: IssueRefusalCode;
      readonly message: string;
    };

export async function issueOperationTemplate(
  deps: IssueTemplateDeps,
  request: IssueTemplateRequest,
): Promise<IssueTemplateOutcome> {
  const { operationType, organ, votingId, targetPath } = request;
  const requirements = deps.templates.requirements(operationType);

  if (requirements.unavailableBoundKeys.length > 0) {
    return refused(
      'BOUND_VALUE_UNAVAILABLE',
      `a ${operationType} record needs ${requirements.unavailableBoundKeys.join(', ')}, ` +
        'which issuance cannot know. A bound value with no issuance-time source needs a ' +
        'schema decision — whether the member supplies it, or the application reads it ' +
        'when the form comes back — not a default invented here.',
    );
  }

  if (requirements.organ && organ === undefined) {
    return refused('ORGAN_REQUIRED', `a ${operationType} template must name an organ`);
  }
  if (!requirements.organ && organ !== undefined) {
    // Refused rather than dropped. An organ silently ignored would let a member
    // believe a theme voting was scoped to their organ when the contract has no
    // argument for it and anyone may vote.
    return refused(
      'ORGAN_NOT_APPLICABLE',
      `a ${operationType} has no organ — the contract takes none, and anyone may vote on it`,
    );
  }
  if (requirements.votingId && (votingId === undefined || votingId.length === 0)) {
    return refused('VOTING_ID_REQUIRED', `a ${operationType} template must name a voting`);
  }

  let organIdentifier: string | undefined;
  if (organ !== undefined) {
    try {
      organIdentifier = (await deps.organs.resolve(organ)).identifier;
    } catch (error) {
      // Only a disagreement becomes a refusal. An unreachable provider is not a
      // verdict about the organ, so it propagates and the caller reports an
      // outage rather than telling the user their organ is wrong.
      if (error instanceof OrganIdentifierMismatchError) {
        return refused('ORGAN_MISMATCH', error.message);
      }
      throw error;
    }
  }

  const operationRef = deps.ids.newOperationRef();
  const file = await deps.templates.issue({
    operationType,
    operationRef,
    context: {
      chainId: deps.deployment.chainId,
      contractAddress: deps.deployment.contractAddress,
      ...(organIdentifier === undefined ? {} : { organIdentifier }),
      ...(votingId === undefined ? {} : { votingId }),
    },
  });

  await deps.store.record({
    operationRef,
    operationType,
    chainId: deps.deployment.chainId,
    contractAddress: deps.deployment.contractAddress,
    boundValues: boundValuesFor(organ, votingId, requirements),
    displayedContext: file.displayedContext,
  });

  await deps.files.write(targetPath, file.bytes);
  await deps.store.advance(operationRef, 'EMITTED');

  return {
    kind: 'ISSUED',
    operationRef,
    path: targetPath,
    ...(organIdentifier === undefined ? {} : { organIdentifier }),
    fieldCount: file.fieldNames.length,
  };
}

/**
 * The values a returned form is **not** allowed to supply, keyed by domain key.
 *
 * These are the keys `FIELD_PLAN[type].bound` names, written from what the caller
 * gave rather than from anything the template printed — the printed copy exists
 * to be compared, and this copy is the one that gets used.
 *
 * Two details have to match `buildIntent`'s organ reader exactly, and both are
 * places a plausible-looking record would fail to bind:
 *
 * **The region travels as its subject code, never as its ordinal.** The ordinal
 * is what a call argument takes and the code is what a document shows, and they
 * differ for 50 of 98 regions — so the record holds the document's form and the
 * region table stays the only route back to an argument.
 *
 * **Only the keys that organ's scope actually uses are written.** The reader asks
 * for `regionSubjectCode` only for a scoped type and `organNumber` only for a
 * local one, so writing a normalized zero for the others would put a value in the
 * record that nothing reads and that a reader could mistake for a real region 0
 * (Adygea).
 */
function boundValuesFor(
  organ: PartyOrganTriple | undefined,
  votingId: string | undefined,
  requirements: { readonly votingId: boolean },
): Readonly<Record<string, string>> {
  const bound: Record<string, string> = {};

  if (organ !== undefined) {
    bound.organType = organ.organType;
    const scope = scopeOf(organ.organType);
    if (scope !== 'GLOBAL') bound.regionSubjectCode = subjectCodeOf(organ.region);
    if (scope === 'LOCAL') bound.organNumber = String(organ.number);
  }

  if (requirements.votingId && votingId !== undefined) bound.votingId = votingId;
  return bound;
}

const refused = (code: IssueRefusalCode, message: string): IssueTemplateOutcome => ({
  kind: 'REFUSED',
  code,
  message,
});
