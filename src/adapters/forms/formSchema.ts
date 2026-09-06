import { OPERATION_TYPES, type OperationType } from '../../domain/intents/intent';

/**
 * The AcroForm field names, shared by issuance, ingestion and stamping.
 *
 * ```text
 * zarya.meta.*      field, app-authored — parser contract and database key
 * zarya.input.*     field, human-filled — the ONLY names read for a value
 * zarya.context.*   NOT a field. Printed as page text.
 * zarya.receipt.*   NOT a field. The receipt is a stamp.
 * ```
 *
 * Hard rule 4: app-authored values come from the operation record via
 * `operationRef`, never from the returned file. The two retired namespaces keep
 * their names so a file carrying one can be refused by name.
 */

/** Bumping this invalidates every issued form. See `DECISIONS.md`. */
export const FORM_SCHEMA_VERSION = 'zarya.form.2';

export const META_FIELDS = {
  schemaVersion: 'zarya.meta.schemaVersion',
  operationRef: 'zarya.meta.operationRef',
  operationType: 'zarya.meta.operationType',
} as const;

/**
 * Printed as page text, not fields. Also the keys `TemplateRequest.context` uses.
 *
 * `organ` is the contract's own rendered identifier (`74.СОВ`), which is what a
 * member can check. The triple behind it lives in the operation record.
 */
export const CONTEXT_FIELDS = {
  chainId: 'zarya.context.chainId',
  contract: 'zarya.context.contract',
  organ: 'zarya.context.organ',
  votingId: 'zarya.context.votingId',
} as const;

/** The six facts a stamp states. Not fields; not written into a template. */
export const RECEIPT_FIELDS = {
  txHash: 'zarya.receipt.txHash',
  status: 'zarya.receipt.status',
  blockNumber: 'zarya.receipt.blockNumber',
  chainId: 'zarya.receipt.chainId',
  /** Chain block timestamp, never workstation time. */
  confirmedAt: 'zarya.receipt.confirmedAt',
  signer: 'zarya.receipt.signer',
} as const;

export const INPUT_PREFIX = 'zarya.input.';

/** A prefix strip, deliberately: a hand-maintained map fails silently on a rename. */
export const inputFieldName = (domainKey: string): string => `${INPUT_PREFIX}${domainKey}`;

/** The domain key a `zarya.input.*` name carries, or `undefined` if it is not one. */
export const domainKeyOf = (fieldName: string): string | undefined =>
  fieldName.startsWith(INPUT_PREFIX) ? fieldName.slice(INPUT_PREFIX.length) : undefined;

/** `UNKNOWN` is a refusal. Nothing here fuzzy-matches a field name. */
export type FieldTrust = 'META' | 'CONTEXT' | 'INPUT' | 'RECEIPT' | 'UNKNOWN';

/** Present on a returned file means hand-edited — a different fact from `UNKNOWN`. */
export const isRetiredNamespace = (trust: FieldTrust): boolean =>
  trust === 'CONTEXT' || trust === 'RECEIPT';

const named = (fields: Readonly<Record<string, string>>): readonly string[] => Object.values(fields);

export function fieldTrust(fieldName: string): FieldTrust {
  if (named(META_FIELDS).includes(fieldName)) return 'META';
  if (named(CONTEXT_FIELDS).includes(fieldName)) return 'CONTEXT';
  if (named(RECEIPT_FIELDS).includes(fieldName)) return 'RECEIPT';
  if (fieldName.startsWith(INPUT_PREFIX)) return 'INPUT';
  return 'UNKNOWN';
}

/** All three are listed; a given organ type uses the ones it needs. */
export const ORGAN_KEYS = ['organType', 'regionSubjectCode', 'organNumber'] as const;

/**
 * Per operation: what a member fills, what the record owns, what chain supplies.
 *
 * **`decimals` on a value proposal is `resolved`, not `bound`.** At issuance
 * there is no cell, so there is no scale to record. It is read from
 * `numericalCell(at).decimals` at submission, for the coordinate the member
 * wrote, which also means it cannot go stale while the form is out.
 *
 * Residual window, still open: a decimals voting executing between that read and
 * the mine leaves the integer scaled by the old precision, and `addValue` takes
 * no scale argument so nothing on chain notices.
 *
 * `decimals` on a *decimals* proposal is `input` — there the member is changing
 * the scale, not using it.
 */
export interface FieldPlan {
  /** Read from `zarya.input.*`, in the order a template lays them out. */
  readonly input: readonly string[];
  /** Recovered from the operation record. Never read from the file. */
  readonly bound: readonly string[];
  /**
   * Read from chain, never written onto a template or stored. Provenance is
   * enforced by who writes the key, and by the unknown-field check refusing a
   * `zarya.input.*` name for it.
   */
  readonly resolved: readonly string[];
}

export const FIELD_PLAN: { readonly [T in OperationType]: FieldPlan } = {
  CREATE_MEMBERSHIP_VOTING: {
    input: ['member', 'duration'],
    bound: [...ORGAN_KEYS],
    resolved: [],
  },
  CREATE_MEMBERSHIP_REVOCATION_VOTING: {
    input: ['member', 'duration'],
    bound: [...ORGAN_KEYS],
    resolved: [],
  },
  CREATE_CATEGORY_VOTING: {
    input: ['x', 'y', 'category', 'categoryName', 'duration'],
    bound: [...ORGAN_KEYS],
    resolved: [],
  },
  // `decimals` here is the *proposal* — a member is asking to change the cell's
  // scale — which is the opposite of its role on a numerical value proposal.
  CREATE_DECIMALS_VOTING: {
    input: ['x', 'y', 'decimals', 'duration'],
    bound: [...ORGAN_KEYS],
    resolved: [],
  },
  // No organ: the contract takes `bool isCategorical` instead and these are open
  // to anyone. A bound organ would be a value that is never sent.
  CREATE_THEME_VOTING: {
    input: ['matrix', 'x', 'theme', 'duration'],
    bound: [],
    resolved: [],
  },
  CREATE_STATEMENT_VOTING: {
    input: ['matrix', 'x', 'y', 'statement', 'duration'],
    bound: [],
    resolved: [],
  },
  CREATE_CATEGORICAL_VALUE_VOTING: {
    input: ['x', 'y', 'category', 'valueAuthor', 'duration'],
    bound: [...ORGAN_KEYS],
    resolved: [],
  },
  // The only `resolved` entry in the schema. `decimals` is the scale of the cell
  // the member addressed, read at import rather than issued or typed — see the
  // note on {@link FieldPlan}.
  CREATE_NUMERICAL_VALUE_VOTING: {
    input: ['x', 'y', 'value', 'valueAuthor', 'duration'],
    bound: [...ORGAN_KEYS],
    resolved: ['decimals'],
  },
  CAST_VOTE: { input: ['support'], bound: ['votingId'], resolved: [] },
  CONFIGURE_ORGAN_THRESHOLDS: {
    input: ['quorum', 'approvalPercentage', 'approvalPercentageBase'],
    bound: [...ORGAN_KEYS],
    resolved: [],
  },
  TRANSFER_CHAIRMANSHIP: { input: ['newChairman'], bound: [], resolved: [] },
};

/** Derived from `bound`, so it cannot disagree with {@link FIELD_PLAN}. */
export function contextFieldsFor(operationType: OperationType): readonly string[] {
  const { bound } = FIELD_PLAN[operationType];
  return [
    CONTEXT_FIELDS.chainId,
    CONTEXT_FIELDS.contract,
    ...(ORGAN_KEYS.some((key) => bound.includes(key)) ? [CONTEXT_FIELDS.organ] : []),
    ...(bound.includes('votingId') ? [CONTEXT_FIELDS.votingId] : []),
  ];
}

/** An accessor so a caller iterates the schema and cannot forget a later key. */
export function resolvedKeysFor(operationType: OperationType): readonly string[] {
  return FIELD_PLAN[operationType].resolved;
}

/** Meta plus inputs. Every widget on an issued form is one a member fills. */
export function templateFieldNames(operationType: OperationType): readonly string[] {
  return [...named(META_FIELDS), ...FIELD_PLAN[operationType].input.map(inputFieldName)];
}

/** Every input field name the schema defines, across all eleven operations. */
export const ALL_INPUT_FIELD_NAMES: readonly string[] = [
  ...new Set(
    OPERATION_TYPES.flatMap((type) => FIELD_PLAN[type].input.map(inputFieldName)),
  ),
];
