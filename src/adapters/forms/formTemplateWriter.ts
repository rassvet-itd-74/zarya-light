import type { OperationType } from '../../domain/intents/intent';
import type {
  ContextRequirements,
  IssueTemplateCommand,
  IssuedTemplateFile,
  TemplateWriter,
} from '../../domain/ports/TemplateWriter';
import { CONTEXT_FIELDS, FIELD_PLAN, ORGAN_KEYS, contextFieldsFor } from './formSchema';
import { type TemplateAssets, contextValuesFor, issueTemplate } from './issueTemplate';

/**
 * `TemplateWriter` over the AcroForm issuer.
 *
 * Thin on purpose — `issueTemplate` already does the work. What this adds is the
 * translation the port exists for: domain values in, field names confined to this
 * side of the boundary, and the printed context map handed back so the caller can
 * record it without knowing that `zarya.context.organ` is a thing.
 */
export class FormTemplateWriter implements TemplateWriter {
  constructor(private readonly assets: TemplateAssets) {}

  /**
   * Derived from `FIELD_PLAN`, never restated.
   *
   * The organ question is answered by asking whether the context block has an
   * organ field, which is itself derived from what is bound — so a schema change
   * moves all three together and there is no second list to forget.
   */
  requirements(operationType: OperationType): ContextRequirements {
    const context = contextFieldsFor(operationType);
    const { bound } = FIELD_PLAN[operationType];

    return {
      organ: context.includes(CONTEXT_FIELDS.organ),
      votingId: context.includes(CONTEXT_FIELDS.votingId),
      unavailableBoundKeys: bound.filter((key) => !KNOWN_AT_ISSUANCE.has(key)),
    };
  }

  async issue(command: IssueTemplateCommand): Promise<IssuedTemplateFile> {
    const displayedContext = contextValuesFor(command.operationType, {
      chainId: String(command.context.chainId),
      contract: command.context.contractAddress,
      ...(command.context.organIdentifier === undefined
        ? {}
        : { organ: command.context.organIdentifier }),
      ...(command.context.votingId === undefined ? {} : { votingId: command.context.votingId }),
    });

    const issued = await issueTemplate(
      {
        operationType: command.operationType,
        operationRef: command.operationRef,
        context: displayedContext,
      },
      this.assets,
    );

    return { bytes: issued.bytes, fieldNames: issued.fieldNames, displayedContext };
  }
}

/**
 * The bound domain keys issuance can actually supply.
 *
 * The organ triple comes from the request and `votingId` from the request, so
 * those four are known. **`decimals` is not**, and its absence from this set is
 * the whole reason `unavailableBoundKeys` exists.
 *
 * `FIELD_PLAN` says `decimals` on a numerical value proposal is bound — "the
 * scale the cell had when the template was issued" — while listing that same
 * operation's `x` and `y` as member-filled, on the grounds that a bound cell
 * would make the matrix reference report pointless. Both statements are in the
 * same file and they cannot both hold: at issuance there is no cell, so there is
 * no scale to record.
 *
 * Neither side is corrected here, because which one gives is a product decision
 * about what a member is asked to choose and when. What this does is make the
 * conflict a refusal a user can read instead of a `decimals` value invented by
 * whichever code path got there first.
 */
const KNOWN_AT_ISSUANCE: ReadonlySet<string> = new Set([...ORGAN_KEYS, 'votingId']);
