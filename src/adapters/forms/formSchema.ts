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
 * ## Two namespaces are fields; two are names kept only to refuse them
 *
 * ```text
 * zarya.meta.*      app-authored — the parser contract and the database key
 * zarya.input.*     human-filled — the ONLY fields read for their value
 *
 * zarya.context.*   NOT a field. Drawn as page text at issuance.
 * zarya.receipt.*   NOT a field. The receipt is a stamp drawn on confirmation.
 * ```
 *
 * Hard rule 4: a form the app issued is still untrusted on return. Every part of
 * a PDF is editable, so the app-authored values are recovered from the operation
 * record via `operationRef` and never from the file.
 *
 * The two lower namespaces used to be read-only widgets — visible, shaded, and
 * indistinguishable at a glance from the boxes a member is meant to fill in.
 * They are now drawn text, which is the same trust rule expressed in a way a
 * reader can see: **the only widgets on an issued form are the ones a member
 * fills.** Their names survive here so a file carrying one can be named and
 * refused rather than met with a generic "unknown field", and because the
 * receipt names still identify what a stamp states.
 */

/**
 * The parser contract version, written into every template and checked on every
 * import.
 *
 * A form carrying anything else is refused outright rather than parsed on a
 * best-effort basis (`INVARIANTS.md`, "Form trust boundary"). Bumping it
 * invalidates every already-issued form, so it changes only when the field set
 * or a field's meaning changes — not when a layout does.
 *
 * Bumped to `.2` on 2026-09-06, when `zarya.context.*` and `zarya.receipt.*`
 * stopped being fields. That invalidates every form issued before it — which was
 * affordable exactly once, because nothing is in circulation yet and the
 * operator's own database could be deleted. It stops being affordable the day
 * the party is holding printed forms.
 */
export const FORM_SCHEMA_VERSION = 'zarya.form.2';

export const META_FIELDS = {
  schemaVersion: 'zarya.meta.schemaVersion',
  operationRef: 'zarya.meta.operationRef',
  operationType: 'zarya.meta.operationType',
} as const;

/**
 * Display only, and no longer fields at all — these name the lines of text an
 * issued form draws in its application block, and the keys
 * `TemplateRequest.context` is supplied under.
 *
 * They are still listed as a namespace because {@link fieldTrust} has to be able
 * to name one: a returned file carrying `zarya.context.chainId` as an actual
 * widget was hand-edited, and saying which retired field it carries is a better
 * refusal than "unknown".
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
 * The six facts a receipt states — no longer fields, and no longer written into
 * an issued template.
 *
 * **Superseded reasoning, kept because it was right until it wasn't.** These were
 * issued empty from the very first slice on the grounds that retrofitting a field
 * invalidates every form already handed out. That held while the receipt *was*
 * fields. It stopped holding when the receipt became a stamp drawn onto the
 * returned page: a drawn mark needs nothing reserved for it at issuance, so there
 * is no longer anything to retrofit, and six empty shaded boxes on every form were
 * six boxes a member had to be told not to fill in.
 *
 * The names survive as the vocabulary of a stamp — what it states, and what a
 * test asserts it drew — and as something {@link fieldTrust} can still name if a
 * file turns up carrying one.
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

/**
 * The namespaces that are no longer written as fields.
 *
 * A form issued by this build carries neither, so one appearing on a returned
 * file was added by hand. Named separately from `UNKNOWN` because the two are
 * different facts about a document.
 */
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
 * Which domain keys a human fills in, which the app recovers from its own
 * record, and which it reads from chain when the form comes back.
 *
 * This split *is* hard rule 4, expressed per operation. Everything in `bound`
 * comes from the operation record found through `operationRef`; nothing in
 * `bound` is ever read from the returned file, even though a template writes a
 * display copy of some of it into `zarya.context.*`.
 *
 * ## Three categories, because two could not describe `decimals`
 *
 * `resolved` settles a contradiction this file used to contain. `decimals` on a
 * numerical value proposal was listed as `bound` — "the scale the cell had when
 * the template was issued" — while that same operation's `x` and `y` were listed
 * as member-filled, on the grounds that a bound cell would make the matrix
 * reference report pointless. Both cannot hold: **at issuance there is no
 * cell**, so there was no scale to record, and `CREATE_NUMERICAL_VALUE_VOTING`
 * could not be issued at all.
 *
 * The scale is not a property of the form or of the record. It is a property of
 * the *cell*, readable at any time, and the only moment it is needed is when a
 * written decimal has to become the integer the contract stores. So it is read
 * then — at import, from `numericalCell(at).decimals`, for the coordinate the
 * member actually wrote. `x` and `y` stay member-filled, which is what the
 * matrix reference report exists to support.
 *
 * That is stronger than binding it, not weaker. A scale recorded at issuance can
 * go stale while the form is out for days; a scale read at import cannot.
 * `12.34` means twelve-point-three-four at whatever precision the cell holds
 * now, which is what the member meant by writing it.
 *
 * **The residual window is import → mined, and nothing closes it yet.** A
 * decimals voting executing in that gap leaves the submitted integer scaled by
 * the old precision, and `addValue` has no argument for the scale so nothing on
 * chain can notice. `GovernanceIntent.decimals` carries the scale that produced
 * the value precisely so a submission-time check can compare it against the cell
 * — no such check exists today, and the field's own note says so.
 *
 * ## Two entries worth reading twice
 *
 * - **`votingId` on a vote.** A tampered voting number in the file would move a
 *   vote onto a different proposal, and the vote itself would succeed. It comes
 *   from the record, and the file's copy is compared to it rather than used.
 * - **`decimals` on a *decimals* proposal is `input`**, not `resolved`. There a
 *   member is asking to change the cell's scale, which is the opposite of its
 *   role on a value proposal.
 *
 * `duration` is human-filled throughout, and deliberately: the contract accepts
 * any value, `durationPolicy` bounds it as client policy, and semantic identity
 * excludes it — proposing the same membership change for a day or a week is the
 * same proposal. Nothing depends on the app owning it.
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
  /**
   * Read from chain at import, for the coordinate the form supplied. Never
   * written onto a template, never stored in the record, never read from the
   * file.
   *
   * A resolved key reaches `buildIntent` in the same `IntentInput` map as the
   * other two, so the builder cannot tell them apart — the provenance rule is
   * enforced by *who writes the key*, which is the import use case, and by the
   * unknown-field check that refuses a `zarya.input.*` field for it.
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

/**
 * The `zarya.context.*` lines a template draws, derived from what is bound
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
 * The domain keys ingestion has to read from chain before it can build an
 * intent.
 *
 * An accessor rather than a direct `FIELD_PLAN[t].resolved` read at the call
 * site, for the same reason {@link contextFieldsFor} is one: the import use case
 * iterates this and cannot forget a key that a later operation adds. Empty for
 * ten of the eleven, which is why forgetting would otherwise go unnoticed until
 * the one that matters.
 */
export function resolvedKeysFor(operationType: OperationType): readonly string[] {
  return FIELD_PLAN[operationType].resolved;
}

/**
 * Every field an issued template carries, in one list.
 *
 * Two namespaces and no more: the three `zarya.meta.*` the parser needs to
 * identify the document, and the `zarya.input.*` a member fills. Context is drawn
 * text and the receipt is a stamp, so neither is here — which is what makes the
 * rule visible on paper rather than only stated in a comment: **every widget on
 * an issued form is one a member is meant to write in.**
 */
export function templateFieldNames(operationType: OperationType): readonly string[] {
  return [...named(META_FIELDS), ...FIELD_PLAN[operationType].input.map(inputFieldName)];
}

/** Every input field name the schema defines, across all eleven operations. */
export const ALL_INPUT_FIELD_NAMES: readonly string[] = [
  ...new Set(
    OPERATION_TYPES.flatMap((type) => FIELD_PLAN[type].input.map(inputFieldName)),
  ),
];
