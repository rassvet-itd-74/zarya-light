import { OPERATION_TYPES, type OperationType } from '../../../domain/intents/intent';
import { INTENT_SAMPLES } from '../../../domain/intents/testing/intentSamples';
import type { IssuedOperation, ParsedFormFields } from '../assembleFormInput';
import {
  CONTEXT_FIELDS,
  FIELD_PLAN,
  FORM_SCHEMA_VERSION,
  META_FIELDS,
  RECEIPT_FIELDS,
  contextFieldsFor,
  inputFieldName,
} from '../formSchema';

/**
 * One completely filled form per operation type, plus the record that was
 * issued alongside it.
 *
 * The values are chosen to reproduce `INTENT_SAMPLES` exactly, so the round-trip
 * test can compare an assembled-and-built intent against the intent fixture the
 * intent layer already tests against. That is the strongest check available
 * before a PDF library exists: it proves the field schema, the bound/input
 * split, and `buildIntent` agree about all eleven operations.
 *
 * Written as raw strings throughout, because that is what a PDF carries. Nothing
 * here is typed as a domain value — the point is that everything crosses this
 * boundary as text a human could have edited.
 */

/** Chechnya's **subject code**, which is what a form asks a human for. */
const REGION_SUBJECT_CODE = '95';

const MEMBER = INTENT_SAMPLES.CREATE_MEMBERSHIP_VOTING.member;
const AUTHOR = INTENT_SAMPLES.CREATE_NUMERICAL_VALUE_VOTING.valueAuthor;

/** The human-filled half, per operation, exactly as text. */
const INPUT_VALUES: { readonly [T in OperationType]: Readonly<Record<string, string>> } = {
  CREATE_MEMBERSHIP_VOTING: { member: MEMBER, duration: '86400' },
  CREATE_MEMBERSHIP_REVOCATION_VOTING: { member: MEMBER, duration: '86400' },
  CREATE_CATEGORY_VOTING: {
    x: '3',
    y: '7',
    category: '5',
    categoryName: 'Good',
    duration: '86400',
  },
  CREATE_DECIMALS_VOTING: { x: '3', y: '7', decimals: '2', duration: '86400' },
  CREATE_THEME_VOTING: {
    matrix: 'CATEGORICAL',
    x: '3',
    theme: 'Жилищный вопрос',
    duration: '86400',
  },
  CREATE_STATEMENT_VOTING: {
    matrix: 'NUMERICAL',
    x: '3',
    y: '7',
    statement: 'Аренда растёт',
    duration: '86400',
  },
  CREATE_CATEGORICAL_VALUE_VOTING: {
    x: '3',
    y: '7',
    category: '5',
    valueAuthor: AUTHOR,
    duration: '86400',
  },
  // `12.34` written against a cell the record says holds two decimals, which is
  // the pair that produces the fixture's stored `1234n`.
  CREATE_NUMERICAL_VALUE_VOTING: {
    x: '3',
    y: '7',
    value: '12.34',
    valueAuthor: AUTHOR,
    duration: '86400',
  },
  CAST_VOTE: { support: 'FOR' },
  CONFIGURE_ORGAN_THRESHOLDS: {
    quorum: '3',
    approvalPercentage: '6600',
    approvalPercentageBase: '10000',
  },
  TRANSFER_CHAIRMANSHIP: { newChairman: MEMBER },
};

/**
 * The app-authored half, keyed by domain key.
 *
 * Every value here is one a form is **not** allowed to supply. The organ arrives
 * as a subject code because that is the only representation the intent builder
 * accepts — there is no route from a code to an ordinal except the region table.
 */
const BOUND_VALUES: Readonly<Record<string, string>> = {
  organType: 'RegionalSoviet',
  regionSubjectCode: REGION_SUBJECT_CODE,
  organNumber: '0',
  // The scale the cell had when the template was issued. Not on the form.
  decimals: '2',
  votingId: '7',
};

export const SAMPLE_OPERATION_REF = 'op_01HQ3ZS8Q0000000000000000';
export const SAMPLE_CHAIN_ID = '11155111';
export const SAMPLE_CONTRACT = '0x6b31cC58a7DC5919f460068cF68D16281F360d25';
export const SAMPLE_ORGAN_LABEL = '95.СОВ';

/** The record the app stored when it issued the template. */
export function issuedOperation(operationType: OperationType): IssuedOperation {
  const plan = FIELD_PLAN[operationType];
  const values: Record<string, string> = {};
  for (const key of plan.bound) values[key] = BOUND_VALUES[key];

  const context: Record<string, string> = {};
  for (const fieldName of contextFieldsFor(operationType)) {
    context[fieldName] =
      fieldName === CONTEXT_FIELDS.chainId
        ? SAMPLE_CHAIN_ID
        : fieldName === CONTEXT_FIELDS.contract
          ? SAMPLE_CONTRACT
          : fieldName === CONTEXT_FIELDS.organ
            ? SAMPLE_ORGAN_LABEL
            : BOUND_VALUES.votingId;
  }

  return { operationRef: SAMPLE_OPERATION_REF, operationType, values, context };
}

/**
 * The form as it comes back: every field a template carries, with the input half
 * filled and the receipt half still empty.
 *
 * The empty receipt fields are present deliberately — that is what an unstamped
 * template looks like, and an intake that refused an empty `txHash` would refuse
 * every legitimate form.
 */
export function filledForm(
  operationType: OperationType,
  overrides: Readonly<Record<string, string | undefined>> = {},
): ParsedFormFields {
  const fields: Record<string, string> = {
    [META_FIELDS.schemaVersion]: FORM_SCHEMA_VERSION,
    [META_FIELDS.operationRef]: SAMPLE_OPERATION_REF,
    [META_FIELDS.operationType]: operationType,
    ...issuedOperation(operationType).context,
  };
  for (const [key, value] of Object.entries(INPUT_VALUES[operationType])) {
    fields[inputFieldName(key)] = value;
  }
  for (const fieldName of Object.values(RECEIPT_FIELDS)) fields[fieldName] = '';

  for (const [fieldName, value] of Object.entries(overrides)) {
    if (value === undefined) delete fields[fieldName];
    else fields[fieldName] = value;
  }
  return fields;
}

/** Every operation type, for a sweep. Re-exported so a suite imports one module. */
export { OPERATION_TYPES };
