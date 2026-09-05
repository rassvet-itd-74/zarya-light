import type { OperationRecord } from '../../domain/ports/OperationStore';
import type {
  FormBinding,
  FormDeploymentScope,
  FormNote,
  ReadFormResult,
  ReturnedForm,
  ReturnedFormReader,
} from '../../domain/ports/ReturnedFormReader';
import type { OperationRef } from '../../domain/primitives';
import { assembleFormInput, readFormReference, type ParsedFormFields } from './assembleFormInput';
import { bindOperation } from './boundOperation';
import { resolvedKeysFor } from './formSchema';
import { parseFormFields } from './pdfFormParser';

/**
 * `ReturnedFormReader` over the form pipeline.
 *
 * Composition and nothing else: the parser, the reference read, the record
 * binding, and the schema assembly all already existed and are already tested.
 * What this adds is that they are reachable through **one port**, so the
 * application service orchestrates a port instead of importing four adapter
 * modules by path.
 *
 * The order is the pipeline's, not this class's, and each step's own module owns
 * its rules. The only decision made here is which failures are `NOT_BINDABLE` —
 * the record cannot back this form — and which are `REFUSED`, meaning the form's
 * own fields are wrong. The two are kept apart because a member can act on the
 * second and not on the first.
 */
export class PdfReturnedFormReader implements ReturnedFormReader {
  async read(bytes: Uint8Array): Promise<ReadFormResult> {
    const parsed = await parseFormFields(bytes);
    if (parsed.kind === 'REJECTED') {
      return { kind: 'UNREADABLE', problems: parsed.rejections.map(toNote) };
    }

    const reference = readFormReference(parsed.fields);
    if (reference.kind === 'REFUSED') {
      return { kind: 'UNREADABLE', problems: reference.refusals.map(toNote) };
    }

    return {
      kind: 'FORM',
      form: new ParsedReturnedForm(reference.operationRef as OperationRef, parsed.fields),
      disclosures: parsed.disclosures.map(toNote),
    };
  }
}

/**
 * One parsed file, held between the reference read and the binding.
 *
 * The fields are kept rather than the bytes so the document is parsed once. They
 * are still untrusted — nothing here decides anything from them — and the record
 * supplied to {@link bind} is what every app-authored value comes from.
 */
class ParsedReturnedForm implements ReturnedForm {
  constructor(
    readonly operationRef: OperationRef,
    private readonly fields: ParsedFormFields,
  ) {}

  bind(record: OperationRecord, scope: FormDeploymentScope): FormBinding {
    const bound = bindOperation(record, scope);
    if (bound.kind === 'REFUSED') {
      return {
        kind: 'NOT_BINDABLE',
        problems: [{ code: bound.code, message: bound.message }],
      };
    }

    const assembled = assembleFormInput(this.fields, bound.issued);
    if (assembled.kind === 'REFUSED') {
      return { kind: 'REFUSED', problems: assembled.refusals.map(toNote) };
    }

    return {
      kind: 'INPUT',
      operationType: assembled.operationType,
      input: assembled.input,
      // Handed out rather than looked up by the caller, so the schema stays
      // behind this port with the rest of the form vocabulary.
      resolvedKeys: resolvedKeysFor(assembled.operationType),
      warnings: assembled.warnings.map(toNote),
    };
  }
}

const toNote = (problem: {
  readonly code: string;
  readonly field?: string;
  readonly message: string;
}): FormNote => ({
  code: problem.code,
  ...(problem.field === undefined ? {} : { field: problem.field }),
  message: problem.message,
});
