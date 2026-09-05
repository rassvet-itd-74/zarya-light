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
 * The organ triple and `votingId` both come from the request, so all four are
 * known, and **every key in every plan's `bound` is now in this set** — an
 * invariant `formSchema.test.ts` asserts directly rather than leaving to this
 * filter to discover at runtime.
 *
 * So `unavailableBoundKeys` is empty for all eleven operations, and the
 * mechanism is kept anyway. It exists because it once fired: `decimals` on a
 * numerical value proposal was listed as bound while the coordinate it belongs
 * to was member-filled, which made the operation unissuable, and this returning
 * the key is how that surfaced as a refusal a user could read instead of a
 * scale invented by whichever code path got there first. `decimals` is now
 * `resolved` — read from the cell at import — so nothing is missing at
 * issuance. The next bound key added without an issuance-time source will be
 * caught by the test, and by this if the test is wrong.
 */
const KNOWN_AT_ISSUANCE: ReadonlySet<string> = new Set([...ORGAN_KEYS, 'votingId']);
