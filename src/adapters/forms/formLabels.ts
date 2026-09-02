import { OPERATION_TYPES, type OperationType } from '../../domain/intents/intent';
import { RU_WORDING } from './formLabels.ru';

/**
 * Every piece of printed text on a template, in one module.
 *
 * The forms are Russian-only. Nothing here is generated, inferred, or
 * translated by this codebase: governance wording is the party's, and a label
 * that says something slightly different from what the party means is a member
 * filling in the wrong thing.
 *
 * ## One flat table of slots, and the Russian in a generated file beside it
 *
 * {@link SLOT_ENGLISH} lists every slot exactly once, keyed by the same string
 * the fill-in file uses. `formLabels.ru.ts` holds the Russian and is
 * **regenerated wholesale** by `npm run wording:apply` from `wording.ru.txt` —
 * so applying the party's wording is one deterministic step rather than 62 hand
 * edits, and a typo on either side is caught by a test rather than becoming a
 * slot that is silently pending forever.
 *
 * A slot with no Russian yet renders in square brackets: impossible to mistake
 * for finished wording, and never blank, because a missing label on a printed
 * form is worse than an obvious placeholder — a member cannot tell the field is
 * unexplained.
 *
 * The **stored** values of option groups are not labels and are not here:
 * `FOR`, `AGAINST`, `CATEGORICAL` and `NUMERICAL` are the AcroForm export
 * values the parser reads, and they stay as they are whatever gets printed
 * beside them.
 */

export type Label =
  | { readonly kind: 'RU'; readonly text: string }
  /** No Russian wording supplied yet. `english` is a description, not a draft. */
  | { readonly kind: 'PENDING'; readonly english: string };

/**
 * Every slot, with the English description that stands in for it.
 *
 * The keys are the contract between `wording.ru.txt`, `formLabels.ru.ts`, and
 * the maps below. Adding a slot means adding it here and regenerating the
 * fill-in file; there is no second list to keep in step.
 */
export const SLOT_ENGLISH: Readonly<Record<string, string>> = {
  'operationTitle.CREATE_MEMBERSHIP_VOTING': 'create membership voting',
  'operationTitle.CREATE_MEMBERSHIP_REVOCATION_VOTING': 'create membership revocation voting',
  'operationTitle.CREATE_CATEGORY_VOTING': 'create category voting',
  'operationTitle.CREATE_DECIMALS_VOTING': 'create decimals voting',
  'operationTitle.CREATE_THEME_VOTING': 'create theme voting',
  'operationTitle.CREATE_STATEMENT_VOTING': 'create statement voting',
  'operationTitle.CREATE_CATEGORICAL_VALUE_VOTING': 'create categorical value voting',
  'operationTitle.CREATE_NUMERICAL_VALUE_VOTING': 'create numerical value voting',
  'operationTitle.CAST_VOTE': 'cast vote',
  'operationTitle.CONFIGURE_ORGAN_THRESHOLDS': 'configure organ thresholds',
  'operationTitle.TRANSFER_CHAIRMANSHIP': 'transfer chairmanship',

  'input.member': 'member address',
  'input.duration': 'voting duration',
  'input.x': 'column (x)',
  'input.y': 'row (y)',
  'input.category': 'category number',
  'input.categoryName': 'category name',
  'input.decimals': 'decimal places',
  'input.matrix': 'which matrix',
  'input.theme': 'theme',
  'input.statement': 'statement',
  'input.value': 'value',
  'input.valueAuthor': 'author of the value',
  'input.support': 'your vote',
  'input.quorum': 'quorum',
  'input.approvalPercentage': 'approval threshold',
  'input.approvalPercentageBase': 'approval base',
  'input.newChairman': 'new chairman',

  'hint.duration': 'in seconds',
  'hint.x': 'from the matrix reference report',
  'hint.y': 'from the matrix reference report',
  'hint.value': 'this cell allows a fixed number of decimal places',
  'hint.decimals': '0 to 255',
  'hint.quorum': 'an exact number of votes, not a percentage',
  'hint.approvalPercentage': 'in basis points',
  'hint.approvalPercentageBase': 'in basis points; 10000 means 100%',
  'hint.categoryName': 'the name shown beside the category number',

  'option.FOR': 'for',
  'option.AGAINST': 'against',
  'option.CATEGORICAL': 'categorical matrix',
  'option.NUMERICAL': 'numerical matrix',

  'context.chainId': 'network',
  'context.contract': 'contract address',
  'context.organ': 'party organ',
  'context.votingId': 'voting number',

  'receipt.txHash': 'transaction hash',
  'receipt.status': 'status',
  'receipt.blockNumber': 'block',
  'receipt.chainId': 'network',
  'receipt.confirmedAt': 'confirmed at',
  'receipt.signer': 'signed by',

  'meta.operationRef': 'operation reference',
  'meta.operationType': 'operation',
  'meta.schemaVersion': 'form version',

  'section.context': 'completed by the application',
  'section.input': 'to be completed by the member',
  'section.receipt': 'transaction receipt',

  'sentence.instruction': 'Fill in only the member block, then return this file to the application.',
  'sentence.tamperNotice':
    'Values in the application block are not read from this file. Editing them changes nothing.',
  'sentence.coordinateDisclosure':
    'Coordinates come from the matrix reference report and are checked again when the form is submitted.',
  'sentence.receiptNotice':
    'The receipt block is filled in by the application after the transaction confirms.',

  /** The application's own name, which the whitepaper already supplies. */
  brand: 'Zarya',
};

export class UnknownLabelSlotError extends Error {
  constructor(readonly slot: string) {
    super(`no label slot named ${JSON.stringify(slot)} — add it to SLOT_ENGLISH`);
    this.name = 'UnknownLabelSlotError';
  }
}

/**
 * The label for a slot: the Russian if it has been supplied, the placeholder
 * otherwise.
 *
 * Throws for a slot that does not exist, rather than returning a placeholder.
 * A mistyped key that quietly rendered as `[undefined]` would be a form printed
 * with a broken label and no test to notice, so it fails at module load — which
 * is the loudest place available.
 */
export function labelFor(slot: string): Label {
  const english = SLOT_ENGLISH[slot];
  if (english === undefined) throw new UnknownLabelSlotError(slot);
  const russian = RU_WORDING[slot];
  return russian === undefined || russian.trim().length === 0
    ? { kind: 'PENDING', english }
    : { kind: 'RU', text: russian };
}

/**
 * What to draw for a label.
 *
 * A pending slot is bracketed so a template built today is visibly a draft on
 * paper.
 */
export const labelText = (label: Label): string =>
  label.kind === 'RU' ? label.text : `[${label.english}]`;

/** Convenience: the drawn text for a slot. */
export const textFor = (slot: string): string => labelText(labelFor(slot));

/**
 * A group of slots sharing a prefix, as a map keyed by the part after the dot.
 *
 * Derived rather than restated, so the grouped maps below cannot list a slot
 * `SLOT_ENGLISH` does not have — or miss one it does.
 */
const group = (prefix: string): Readonly<Record<string, Label>> => {
  const entries = Object.keys(SLOT_ENGLISH)
    .filter((slot) => slot.startsWith(`${prefix}.`))
    .map((slot) => [slot.slice(prefix.length + 1), labelFor(slot)] as const);
  return Object.fromEntries(entries);
};

/**
 * The heading at the top of each form.
 *
 * Built through `OPERATION_TYPES` rather than by prefix filtering, so a twelfth
 * operation type is a load-time failure here instead of a form with no title.
 */
export const OPERATION_TITLES: { readonly [T in OperationType]: Label } = Object.fromEntries(
  OPERATION_TYPES.map((type) => [type, labelFor(`operationTitle.${type}`)]),
) as { readonly [T in OperationType]: Label };

/** One label per domain key a member fills in, keyed by the domain key. */
export const INPUT_LABELS = group('input');

/**
 * The short line under a field, for the places where a unit or a source is where
 * mistakes actually happen.
 *
 * Absent for every other field on purpose: a hint under a self-evident label is
 * noise that trains a reader to skip the ones that matter.
 */
export const INPUT_HINTS = group('hint');

/**
 * Printed beside an option box. The key is the **export value**, which is what
 * the parser reads and what must not change.
 */
export const OPTION_LABELS = group('option');

/** Labels for the app-authored context block. Display only. */
export const CONTEXT_LABELS = group('context');

export const RECEIPT_LABELS = group('receipt');

export const META_LABELS = group('meta');

export const SECTION_LABELS = {
  /** The block the application filled in. */
  context: labelFor('section.context'),
  /** The block the member fills in. */
  input: labelFor('section.input'),
  /** The block the application stamps after confirmation. */
  receipt: labelFor('section.receipt'),
} as const;

export const SENTENCES = {
  instruction: labelFor('sentence.instruction'),
  tamperNotice: labelFor('sentence.tamperNotice'),
  coordinateDisclosure: labelFor('sentence.coordinateDisclosure'),
  receiptNotice: labelFor('sentence.receiptNotice'),
} as const;

export const BRAND = labelFor('brand');

export const LABEL_SLOT_COUNT = Object.keys(SLOT_ENGLISH).length;

/** The slots still awaiting Russian wording, by key. */
export const pendingLabels = (): readonly string[] =>
  Object.keys(SLOT_ENGLISH).filter((slot) => labelFor(slot).kind === 'PENDING');

/**
 * Keys present in the generated wording that no slot claims.
 *
 * The other half of the typo check: a key misspelled in `wording.ru.txt` would
 * otherwise sit in `formLabels.ru.ts` doing nothing while its slot stayed
 * pending, and both halves would look correct in isolation.
 */
export const orphanedWording = (): readonly string[] =>
  Object.keys(RU_WORDING).filter((slot) => SLOT_ENGLISH[slot] === undefined);

/**
 * Every character the templates will draw, so the embedded font can be checked
 * to cover them before a form is printed rather than after.
 */
export const drawnCharacters = (): string =>
  Object.keys(SLOT_ENGLISH)
    .map((slot) => textFor(slot))
    .join('');
