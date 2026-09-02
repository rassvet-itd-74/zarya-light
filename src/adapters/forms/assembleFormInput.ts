import type { IntentInput } from '../../domain/intents/fields';
import { type OperationType, isOperationType } from '../../domain/intents/intent';
import {
  CONTEXT_FIELDS,
  FIELD_PLAN,
  FORM_SCHEMA_VERSION,
  META_FIELDS,
  RECEIPT_FIELDS,
  fieldTrust,
  inputFieldName,
} from './formSchema';

/**
 * A parsed form plus its operation record, to the `IntentInput` the domain
 * builder takes.
 *
 * This is the second narrow point in the pipeline, and it is narrow in a
 * different way from the first. `buildIntent` decides whether a *value* is
 * usable; this decides which values are even looked at. Hard rule 4: read only
 * the fields a human is meant to fill, and recover everything else from the
 * operation record via `operationRef` — never from the returned file.
 *
 * It ends at a neutral `Record<string, string>`. No chain library, no calldata,
 * no signer, no storage: given the same form and the same record it produces the
 * same result, so a refusal here is never an outage.
 *
 * ## Bound forms only
 *
 * An import with no `operationRef`, or one naming a record the caller could not
 * find, is refused rather than treated as a generic blank form. An unbound form
 * would have to supply the organ triple from the file, which is the one thing
 * the `bound` half of {@link FIELD_PLAN} exists to prevent, and `zarya-pdf-forms`
 * says to support unbound forms only if the product requires it. Nothing has
 * asked for them.
 */

/** Field values exactly as a PDF carried them, keyed by full AcroForm name. */
export type ParsedFormFields = Readonly<Record<string, string>>;

/**
 * What the app itself recorded when it issued the template.
 *
 * The caller looks this up by the form's `operationRef`; Phase 5 makes that a
 * database read. `values` is keyed by **domain key**, matching
 * `FIELD_PLAN[type].bound`, because these go straight into the intent builder.
 * `context` is keyed by **field name**, because its only job is to be compared
 * against what the file says.
 */
export interface IssuedOperation {
  readonly operationRef: string;
  readonly operationType: OperationType;
  readonly values: Readonly<Record<string, string>>;
  readonly context: Readonly<Record<string, string>>;
}

export type FormRefusalCode =
  | 'MISSING_SCHEMA_VERSION'
  | 'UNKNOWN_SCHEMA_VERSION'
  | 'MISSING_OPERATION_REF'
  | 'OPERATION_REF_MISMATCH'
  | 'MISSING_OPERATION_TYPE'
  | 'UNKNOWN_OPERATION_TYPE'
  | 'OPERATION_TYPE_MISMATCH'
  | 'UNKNOWN_FIELD'
  | 'MISSING_INPUT_FIELD'
  | 'RECEIPT_ALREADY_STAMPED'
  | 'MISSING_BOUND_VALUE';

export interface FormRefusal {
  readonly code: FormRefusalCode;
  /** The field name that caused it, where one did. */
  readonly field?: string;
  /** One line, safe to show a user. Never echoes an unbounded input back. */
  readonly message: string;
}

/**
 * A disagreement between the file and the record, reported and then ignored.
 *
 * Not a refusal: the app-authored value is used regardless, so a tampered
 * context field changes nothing about the transaction. It is surfaced because a
 * member who edited one may have believed it would take effect, and because it
 * is evidence about the file.
 */
export interface FormWarning {
  readonly code: 'CONTEXT_TAMPERED';
  readonly field: string;
  readonly message: string;
}

export type FormIntakeResult =
  | {
      readonly kind: 'INPUT';
      readonly operationType: OperationType;
      readonly input: IntentInput;
      readonly warnings: readonly FormWarning[];
    }
  | { readonly kind: 'REFUSED'; readonly refusals: readonly FormRefusal[] };

/** How long a meta or context field may be before it is not worth comparing. */
const MAX_COMPARED_LENGTH = 256;

const short = (value: string): string =>
  value.length <= 64 ? JSON.stringify(value) : `${JSON.stringify(value.slice(0, 64))}…`;

/**
 * Resolves the operation record a form names, or says why it cannot.
 *
 * Split out from {@link assembleFormInput} because the lookup is I/O in every
 * real caller and this stays pure. The `schemaVersion` check happens here, before
 * anything else is read: an unrecognised version means the field names in the
 * file mean something this build does not know, so continuing to read them would
 * be the best-effort parsing `INVARIANTS.md` forbids.
 */
export function readFormReference(
  form: ParsedFormFields,
): { readonly kind: 'REF'; readonly operationRef: string } | { readonly kind: 'REFUSED'; readonly refusals: readonly FormRefusal[] } {
  const version = form[META_FIELDS.schemaVersion];
  if (version === undefined || version.trim().length === 0) {
    return {
      kind: 'REFUSED',
      refusals: [
        {
          code: 'MISSING_SCHEMA_VERSION',
          field: META_FIELDS.schemaVersion,
          message:
            'This file does not identify itself as a Zarya governance form. The matrix reference report is not a form and cannot be imported.',
        },
      ],
    };
  }
  if (version.trim() !== FORM_SCHEMA_VERSION) {
    return {
      kind: 'REFUSED',
      refusals: [
        {
          code: 'UNKNOWN_SCHEMA_VERSION',
          field: META_FIELDS.schemaVersion,
          message: `This form was issued for form schema ${short(
            version.trim(),
          )}; this application reads ${FORM_SCHEMA_VERSION}. Reissue the form rather than editing the version.`,
        },
      ],
    };
  }

  const operationRef = form[META_FIELDS.operationRef]?.trim();
  if (operationRef === undefined || operationRef.length === 0) {
    return {
      kind: 'REFUSED',
      refusals: [
        {
          code: 'MISSING_OPERATION_REF',
          field: META_FIELDS.operationRef,
          message:
            'This form carries no operation reference, so the values this application authored cannot be recovered. Only forms issued by this application can be imported.',
        },
      ],
    };
  }
  return { kind: 'REF', operationRef };
}

/**
 * The whole of intake's structural decision, given a form and the record it
 * named.
 *
 * The order of the checks is part of the behavior: the marker that says "this is
 * a receipt coming back around" is tested before any field is read for a value,
 * so a stamped form never reaches validation at all.
 */
export function assembleFormInput(
  form: ParsedFormFields,
  issued: IssuedOperation,
): FormIntakeResult {
  const reference = readFormReference(form);
  if (reference.kind === 'REFUSED') return reference;

  const refusals: FormRefusal[] = [];

  if (reference.operationRef !== issued.operationRef) {
    // The caller looked the record up by something; if it does not match, the
    // two are about different operations and neither is trustworthy here.
    refusals.push({
      code: 'OPERATION_REF_MISMATCH',
      field: META_FIELDS.operationRef,
      message: 'This form names a different operation than the record supplied for it.',
    });
  }

  // The re-import marker. A receipt is flattened, so this normally cannot even
  // be read — that is the second, independent mechanism, and neither relies on
  // the other. A hand-typed hash lands here too, which is the same refusal.
  const stamped = form[RECEIPT_FIELDS.txHash]?.trim();
  if (stamped !== undefined && stamped.length > 0) {
    refusals.push({
      code: 'RECEIPT_ALREADY_STAMPED',
      field: RECEIPT_FIELDS.txHash,
      message:
        'This form already carries a transaction receipt, so it has been submitted or has been edited to look as though it was. It cannot be imported again.',
    });
  }

  const declared = form[META_FIELDS.operationType]?.trim();
  if (declared === undefined || declared.length === 0) {
    refusals.push({
      code: 'MISSING_OPERATION_TYPE',
      field: META_FIELDS.operationType,
      message: 'This form does not say which operation it is for.',
    });
  } else if (!isOperationType(declared)) {
    refusals.push({
      code: 'UNKNOWN_OPERATION_TYPE',
      field: META_FIELDS.operationType,
      message: `${short(
        declared,
      )} is not an operation this application performs. The list of operations is fixed and a form cannot name one outside it.`,
    });
  } else if (declared !== issued.operationType) {
    // The record decides, so this is a refusal rather than a warning: the field
    // set that would be read is chosen by the operation type, and reading one
    // operation's fields as another's is how a form gets reinterpreted.
    refusals.push({
      code: 'OPERATION_TYPE_MISMATCH',
      field: META_FIELDS.operationType,
      message: `This form says it is a ${declared} but was issued as a ${issued.operationType}.`,
    });
  }

  const plan = FIELD_PLAN[issued.operationType];
  const allowed = new Set(plan.input.map(inputFieldName));

  for (const fieldName of Object.keys(form)) {
    const trust = fieldTrust(fieldName);
    if (trust === 'UNKNOWN') {
      refusals.push({
        code: 'UNKNOWN_FIELD',
        field: fieldName,
        message: `This form carries a field this application does not recognise. Field names are never matched approximately.`,
      });
      continue;
    }
    if (trust === 'INPUT' && !allowed.has(fieldName)) {
      // An input field belonging to a *different* operation. This is the one
      // that matters: `zarya.input.decimals` added to a numerical value form
      // would be an attempt to supply the cell's scale, which is bound.
      refusals.push({
        code: 'UNKNOWN_FIELD',
        field: fieldName,
        message: `This field does not belong on a ${issued.operationType} form.`,
      });
    }
  }

  const input: Record<string, string> = {};

  for (const key of plan.input) {
    const fieldName = inputFieldName(key);
    const value = form[fieldName];
    if (value === undefined) {
      // Absent rather than blank. A blank field is a person who did not fill it
      // in and `buildIntent` says so per field; an absent one means the form was
      // flattened or edited, and the two deserve different answers.
      refusals.push({
        code: 'MISSING_INPUT_FIELD',
        field: fieldName,
        message:
          'This field is missing from the form itself. A flattened or printed-and-rescanned PDF loses its fields and has to be filled in again electronically.',
      });
      continue;
    }
    input[key] = value;
  }

  for (const key of plan.bound) {
    const value = issued.values[key];
    if (value === undefined) {
      refusals.push({
        code: 'MISSING_BOUND_VALUE',
        field: key,
        message: `The record for this operation is missing ${key}, which this application authored. The form cannot be completed from it.`,
      });
      continue;
    }
    // Written **after** the input loop, so a bound key wins even if an input
    // field somehow carried it. The unknown-field check above already refuses
    // that case; this is the second mechanism, and it does not depend on the
    // first being correct.
    input[key] = value;
  }

  const warnings = compareContext(form, issued);

  return refusals.length > 0
    ? { kind: 'REFUSED', refusals }
    : { kind: 'INPUT', operationType: issued.operationType, input, warnings };
}

/**
 * The tamper check: compare, never use.
 *
 * Only fields the record actually has an expected value for are compared. A
 * context field the record says nothing about produces no warning, because
 * "unknown" and "disagrees" are different and only one of them is evidence.
 */
function compareContext(form: ParsedFormFields, issued: IssuedOperation): readonly FormWarning[] {
  const warnings: FormWarning[] = [];
  for (const fieldName of Object.values(CONTEXT_FIELDS)) {
    const expected = issued.context[fieldName];
    if (expected === undefined) continue;
    const actual = form[fieldName];
    if (actual === undefined) continue;
    if (actual.trim().slice(0, MAX_COMPARED_LENGTH) === expected.trim()) continue;
    warnings.push({
      code: 'CONTEXT_TAMPERED',
      field: fieldName,
      message: `This form displays ${short(
        actual.trim(),
      )} where this application recorded ${short(
        expected.trim(),
      )}. The recorded value is the one being used.`,
    });
  }
  return warnings;
}
