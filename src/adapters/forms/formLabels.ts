import { OPERATION_TYPES, type OperationType } from '../../domain/intents/intent';

/**
 * Every piece of printed text on a template, in one module.
 *
 * The forms are Russian-only. Nothing here is generated, inferred, or
 * translated by this codebase: governance wording is the party's, and a label
 * that says something slightly different from what the party means is a member
 * filling in the wrong thing.
 *
 * ## Wording still outstanding is a value, not a comment
 *
 * A slot that has no Russian text yet is {@link pending}, which renders in
 * square brackets and is impossible to mistake for finished wording. The
 * alternative — a `TODO` comment and a placeholder that reads like real text —
 * is how a draft ships. {@link pendingLabels} enumerates what is left, and a
 * test prints the count, so "which strings are unworded" is a question the
 * suite answers rather than something anyone has to remember.
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

const ru = (text: string): Label => ({ kind: 'RU', text });
const pending = (english: string): Label => ({ kind: 'PENDING', english });

/**
 * What to draw for a label.
 *
 * A pending slot is bracketed so a template built today is visibly a draft on
 * paper. It is never blank — a missing label on a form is worse than an obvious
 * placeholder, because a member cannot tell the field is unexplained.
 */
export const labelText = (label: Label): string =>
  label.kind === 'RU' ? label.text : `[${label.english}]`;

/** The heading at the top of each form. */
export const OPERATION_TITLES: { readonly [T in OperationType]: Label } = {
  CREATE_MEMBERSHIP_VOTING: pending('create membership voting'),
  CREATE_MEMBERSHIP_REVOCATION_VOTING: pending('create membership revocation voting'),
  CREATE_CATEGORY_VOTING: pending('create category voting'),
  CREATE_DECIMALS_VOTING: pending('create decimals voting'),
  CREATE_THEME_VOTING: pending('create theme voting'),
  CREATE_STATEMENT_VOTING: pending('create statement voting'),
  CREATE_CATEGORICAL_VALUE_VOTING: pending('create categorical value voting'),
  CREATE_NUMERICAL_VALUE_VOTING: pending('create numerical value voting'),
  CAST_VOTE: pending('cast vote'),
  CONFIGURE_ORGAN_THRESHOLDS: pending('configure organ thresholds'),
  TRANSFER_CHAIRMANSHIP: pending('transfer chairmanship'),
};

/**
 * One label per domain key a member fills in, keyed by the domain key itself so
 * a field with no label is a missing property rather than a blank line.
 */
export const INPUT_LABELS: Readonly<Record<string, Label>> = {
  member: pending('member address'),
  duration: pending('voting duration'),
  x: pending('column (x)'),
  y: pending('row (y)'),
  category: pending('category number'),
  categoryName: pending('category name'),
  decimals: pending('decimal places'),
  matrix: pending('which matrix'),
  theme: pending('theme'),
  statement: pending('statement'),
  value: pending('value'),
  valueAuthor: pending('author of the value'),
  support: pending('your vote'),
  quorum: pending('quorum'),
  approvalPercentage: pending('approval threshold'),
  approvalPercentageBase: pending('approval base'),
  newChairman: pending('new chairman'),
};

/**
 * The short line under a field, for the eight places where a unit or a source
 * is where mistakes actually happen.
 *
 * Absent for every other field on purpose: a hint under a self-evident label is
 * noise that trains a reader to skip the ones that matter.
 */
export const INPUT_HINTS: Readonly<Record<string, Label>> = {
  duration: pending('in seconds'),
  x: pending('from the matrix reference report'),
  y: pending('from the matrix reference report'),
  value: pending('this cell allows a fixed number of decimal places'),
  decimals: pending('0 to 255'),
  quorum: pending('an exact number of votes, not a percentage'),
  approvalPercentage: pending('in basis points'),
  approvalPercentageBase: pending('in basis points; 10000 means 100%'),
  categoryName: pending('the name shown beside the category number'),
};

/**
 * Printed beside an option box. The key is the **export value**, which is what
 * the parser reads and what must not change.
 */
export const OPTION_LABELS: Readonly<Record<string, Label>> = {
  FOR: pending('for'),
  AGAINST: pending('against'),
  CATEGORICAL: pending('categorical matrix'),
  NUMERICAL: pending('numerical matrix'),
};

/** Labels for the app-authored context block. Display only. */
export const CONTEXT_LABELS: Readonly<Record<string, Label>> = {
  chainId: pending('network'),
  contract: pending('contract address'),
  organ: pending('party organ'),
  votingId: pending('voting number'),
};

export const RECEIPT_LABELS: Readonly<Record<string, Label>> = {
  txHash: pending('transaction hash'),
  status: pending('status'),
  blockNumber: pending('block'),
  chainId: pending('network'),
  confirmedAt: pending('confirmed at'),
  signer: pending('signed by'),
};

export const META_LABELS: Readonly<Record<string, Label>> = {
  operationRef: pending('operation reference'),
  operationType: pending('operation'),
  schemaVersion: pending('form version'),
};

export const SECTION_LABELS = {
  /** The block the application filled in. */
  context: pending('completed by the application'),
  /** The block the member fills in. */
  input: pending('to be completed by the member'),
  /** The block the application stamps after confirmation. */
  receipt: pending('transaction receipt'),
} as const;

export const SENTENCES = {
  instruction: pending(
    'Fill in only the member block, then return this file to the application.',
  ),
  tamperNotice: pending(
    'Values in the application block are not read from this file. Editing them changes nothing.',
  ),
  coordinateDisclosure: pending(
    'Coordinates come from the matrix reference report and are checked again when the form is submitted.',
  ),
  receiptNotice: pending(
    'The receipt block is filled in by the application after the transaction confirms.',
  ),
} as const;

/** The application's own name, which is Cyrillic in the whitepaper's own text. */
export const BRAND = ru('Заря');

/** Every label slot, in one list, for counting and for the pending report. */
const ALL_LABELS: readonly (readonly [string, Label])[] = [
  ...OPERATION_TYPES.map((type) => [`operationTitle.${type}`, OPERATION_TITLES[type]] as const),
  ...Object.entries(INPUT_LABELS).map(([key, label]) => [`input.${key}`, label] as const),
  ...Object.entries(INPUT_HINTS).map(([key, label]) => [`hint.${key}`, label] as const),
  ...Object.entries(OPTION_LABELS).map(([key, label]) => [`option.${key}`, label] as const),
  ...Object.entries(CONTEXT_LABELS).map(([key, label]) => [`context.${key}`, label] as const),
  ...Object.entries(RECEIPT_LABELS).map(([key, label]) => [`receipt.${key}`, label] as const),
  ...Object.entries(META_LABELS).map(([key, label]) => [`meta.${key}`, label] as const),
  ...Object.entries(SECTION_LABELS).map(([key, label]) => [`section.${key}`, label] as const),
  ...Object.entries(SENTENCES).map(([key, label]) => [`sentence.${key}`, label] as const),
  ['brand', BRAND] as const,
];

export const LABEL_SLOT_COUNT = ALL_LABELS.length;

/** The slots still awaiting Russian wording, by key. */
export const pendingLabels = (): readonly string[] =>
  ALL_LABELS.filter(([, label]) => label.kind === 'PENDING').map(([key]) => key);

/**
 * Every character the templates will draw, so the embedded font subset can be
 * checked to cover them before a form is printed rather than after.
 */
export const drawnCharacters = (): string =>
  ALL_LABELS.map(([, label]) => labelText(label)).join('');
