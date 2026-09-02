import { OPERATION_TYPES, type OperationType } from '../../domain/intents/intent';

/**
 * The AcroForm field-name schema, in one module all three form directions
 * import.
 *
 * Issuance writes these names, ingestion reads them, and receipt stamping fills
 * the last namespace. They are in one file because a change to one direction is
 * a change to all three, and two copies of a field name is how an issued
 * template stops being ingestible by the app that issued it.
 *
 * Nothing here touches a PDF. These are strings and a plan; the library that
 * puts them in a document arrives in the next slice, and keeping the schema
 * separate means the plan is testable without one.
 *
 * ## The namespaces are trust levels, not tidiness
 *
 * ```text
 * zarya.meta.*      app-authored — the parser contract and the database key
 * zarya.context.*   app-authored — display and tamper detection only
 * zarya.input.*     human-filled — the ONLY fields read for their value
 * zarya.receipt.*   app-authored — empty until a transaction confirms
 * ```
 *
 * Hard rule 4: a form the app issued is still untrusted on return. Every part of
 * a PDF is editable, so the app-authored namespaces are read to *detect*
 * tampering and never to obtain a value — those come from the operation record
 * via `operationRef`. `zarya.receipt.*` is covered by the same rule, which is
 * why a plausible transaction hash typed into it achieves nothing.
 */

/**
 * The parser contract version, written into every template and checked on every
 * import.
 *
 * A form carrying anything else is refused outright rather than parsed on a
 * best-effort basis (`INVARIANTS.md`, "Form trust boundary"). Bumping it
 * invalidates every already-issued form, so it changes only when the field set
 * or a field's meaning changes — not when a layout does.
 */
export const FORM_SCHEMA_VERSION = 'zarya.form.1';

export const META_FIELDS = {
  schemaVersion: 'zarya.meta.schemaVersion',
  operationRef: 'zarya.meta.operationRef',
  operationType: 'zarya.meta.operationType',
} as const;

/**
 * Display and tamper detection. Never a source of a value.
 *
 * `organ` carries the contract's own rendered identifier — `74.СОВ` — because
 * that is what a member can check against the organ they believe they are
 * proposing for. The authoritative triple behind it is in the operation record;
 * a label cannot be resolved back to a triple without the local table, and
 * doing so from an untrusted file would defeat the point.
 */
export const CONTEXT_FIELDS = {
  chainId: 'zarya.context.chainId',
  contract: 'zarya.context.contract',
  organ: 'zarya.context.organ',
  votingId: 'zarya.context.votingId',
} as const;

/**
 * Present and empty in every issued template.
 *
 * Defined here, in the first slice that defines anything, because retrofitting
 * them later invalidates every form already handed out — the field has to exist
 * before there is a transaction to stamp into it.
 */
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

/**
 * A field name for a domain key, by construction.
 *
 * `zarya.input.member` carries the domain key `member`, so the mapping from the
 * form vocabulary to the domain vocabulary is a prefix strip and there is no
 * translation table to fall out of date. The two vocabularies are allowed to
 * coincide here precisely because the alternative — a hand-maintained map —
 * fails silently when a key is renamed on one side.
 */
export const inputFieldName = (domainKey: string): string => `${INPUT_PREFIX}${domainKey}`;

/** The domain key a `zarya.input.*` name carries, or `undefined` if it is not one. */
export const domainKeyOf = (fieldName: string): string | undefined =>
  fieldName.startsWith(INPUT_PREFIX) ? fieldName.slice(INPUT_PREFIX.length) : undefined;

/**
 * Which of a form's namespaces a field name belongs to.
 *
 * `UNKNOWN` is a refusal, not a shrug: an unrecognised field name is an error
 * rather than a near-miss to resolve, and nothing in this codebase fuzzy-matches
 * one. A form with a field the schema does not name has been edited, and which
 * way it was edited is not knowable from the file.
 */
export type FieldTrust = 'META' | 'CONTEXT' | 'INPUT' | 'RECEIPT' | 'UNKNOWN';

const named = (fields: Readonly<Record<string, string>>): readonly string[] => Object.values(fields);

export function fieldTrust(fieldName: string): FieldTrust {
  if (named(META_FIELDS).includes(fieldName)) return 'META';
  if (named(CONTEXT_FIELDS).includes(fieldName)) return 'CONTEXT';
  if (named(RECEIPT_FIELDS).includes(fieldName)) return 'RECEIPT';
  if (fieldName.startsWith(INPUT_PREFIX)) return 'INPUT';
  return 'UNKNOWN';
}

/**
 * The three domain keys that make up an organ triple.
 *
 * `organNumber` is read only for a local organ and `regionSubjectCode` only for
 * a scoped one, so a plan lists all three and a given form supplies the ones its
 * organ type needs. Listing fewer would make the schema depend on which organ a
 * template happened to be issued for.
 */
export const ORGAN_KEYS = ['organType', 'regionSubjectCode', 'organNumber'] as const;

/**
 * Which domain keys a human fills in and which the app recovers from its own
 * record.
 *
 * This split *is* hard rule 4, expressed per operation. Everything in `bound`
 * comes from the operation record found through `operationRef`; nothing in
 * `bound` is ever read from the returned file, even though a template writes a
 * display copy of some of it into `zarya.context.*`.
 *
 * Two entries in `bound` are worth reading twice:
 *
 * - **`decimals` on a numerical value proposal.** It is the scale the *cell* had
 *   when the template was issued, not something a member typed. A form allowed
 *   to state its own scale could submit a number a hundred times too small and
 *   nothing on chain would notice — the contract has no argument for it. See
 *   `buildIntent`'s `numericalValue`.
 * - **`votingId` on a vote.** A tampered voting number in the file would move a
 *   vote onto a different proposal, and the vote itself would succeed. It comes
 *   from the record, and the file's copy is compared to it rather than used.
 *
 * `duration` is human-filled throughout, and deliberately: the contract accepts
 * any value, `durationPolicy` bounds it as client policy, and semantic identity
 * excludes it — proposing the same membership change for a day or a week is the
 * same proposal. Nothing depends on the app owning it.
 *
 * The coordinates are human-filled for the same reason the matrix reference
 * report exists: it is the document a voter consults to learn which `(x, y)` to
 * write. A bound cell would make the report pointless.
 *
 * There is no `zarya.input.signer`. The app has one wallet and one serialized
 * write queue (hard rule 8), so a field for it would ask a member to choose
 * something that cannot be honoured.
 */
export interface FieldPlan {
  /** Read from `zarya.input.*`, in the order a template lays them out. */
  readonly input: readonly string[];
  /** Recovered from the operation record. Never read from the file. */
  readonly bound: readonly string[];
}

export const FIELD_PLAN: { readonly [T in OperationType]: FieldPlan } = {
  CREATE_MEMBERSHIP_VOTING: { input: ['member', 'duration'], bound: [...ORGAN_KEYS] },
  CREATE_MEMBERSHIP_REVOCATION_VOTING: { input: ['member', 'duration'], bound: [...ORGAN_KEYS] },
  CREATE_CATEGORY_VOTING: {
    input: ['x', 'y', 'category', 'categoryName', 'duration'],
    bound: [...ORGAN_KEYS],
  },
  // `decimals` here is the *proposal* — a member is asking to change the cell's
  // scale — which is the opposite of its role on a numerical value proposal.
  CREATE_DECIMALS_VOTING: { input: ['x', 'y', 'decimals', 'duration'], bound: [...ORGAN_KEYS] },
  // No organ: the contract takes `bool isCategorical` instead and these are open
  // to anyone. A bound organ would be a value that is never sent.
  CREATE_THEME_VOTING: { input: ['matrix', 'x', 'theme', 'duration'], bound: [] },
  CREATE_STATEMENT_VOTING: { input: ['matrix', 'x', 'y', 'statement', 'duration'], bound: [] },
  CREATE_CATEGORICAL_VALUE_VOTING: {
    input: ['x', 'y', 'category', 'valueAuthor', 'duration'],
    bound: [...ORGAN_KEYS],
  },
  CREATE_NUMERICAL_VALUE_VOTING: {
    input: ['x', 'y', 'value', 'valueAuthor', 'duration'],
    bound: [...ORGAN_KEYS, 'decimals'],
  },
  CAST_VOTE: { input: ['support'], bound: ['votingId'] },
  CONFIGURE_ORGAN_THRESHOLDS: {
    input: ['quorum', 'approvalPercentage', 'approvalPercentageBase'],
    bound: [...ORGAN_KEYS],
  },
  TRANSFER_CHAIRMANSHIP: { input: ['newChairman'], bound: [] },
};

/**
 * The `zarya.context.*` fields a template carries, derived from what is bound
 * rather than listed again.
 *
 * A membership form has no voting to name and a theme form has no organ, and a
 * blank field for either is a field with no meaning that a reader has to
 * interpret. Deriving the set means it cannot disagree with {@link FIELD_PLAN}.
 */
export function contextFieldsFor(operationType: OperationType): readonly string[] {
  const { bound } = FIELD_PLAN[operationType];
  return [
    CONTEXT_FIELDS.chainId,
    CONTEXT_FIELDS.contract,
    ...(ORGAN_KEYS.some((key) => bound.includes(key)) ? [CONTEXT_FIELDS.organ] : []),
    ...(bound.includes('votingId') ? [CONTEXT_FIELDS.votingId] : []),
  ];
}

/**
 * Every field an issued template must carry, in one list.
 *
 * The receipt fields are included and empty. A template missing them is one that
 * can never be stamped without being reissued, so they are part of the template
 * rather than something added later.
 */
export function templateFieldNames(operationType: OperationType): readonly string[] {
  return [
    ...named(META_FIELDS),
    ...contextFieldsFor(operationType),
    ...FIELD_PLAN[operationType].input.map(inputFieldName),
    ...named(RECEIPT_FIELDS),
  ];
}

/** Every input field name the schema defines, across all eleven operations. */
export const ALL_INPUT_FIELD_NAMES: readonly string[] = [
  ...new Set(
    OPERATION_TYPES.flatMap((type) => FIELD_PLAN[type].input.map(inputFieldName)),
  ),
];
