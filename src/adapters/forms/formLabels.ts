import { OPERATION_TYPES, type OperationType } from '../../domain/intents/intent';
import { RU_WORDING } from './formLabels.ru';

/**
 * Every printed string this application draws — forms and the matrix report — in
 * one table, so the party fills in one file and one check proves PT Sans covers
 * all of it.
 *
 * Russian only. Nothing here is translated by this codebase: governance wording
 * is the party's, and a label that means something slightly different is a
 * member filling in the wrong thing.
 *
 * {@link SLOT_ENGLISH} lists every slot; `formLabels.ru.ts` holds the Russian
 * and is regenerated wholesale by `npm run wording:apply`. An unworded slot
 * renders in square brackets — never blank, because a missing label is worse
 * than an obvious placeholder.
 *
 * Option **export values** (`FOR`, `AGAINST`, `CATEGORICAL`, `NUMERICAL`) are
 * not labels and are not here.
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

  // Drawn **inside the stamp**, not beside a field — there are no receipt fields
  // any more. Each sits above its value in a ruled band, at 6.5pt, so these are
  // the tightest labels in the application.
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

  'sentence.instruction': 'Fill in only the member block, then return this file to the application.',
  'sentence.coordinateDisclosure':
    'Coordinates come from the matrix reference report and are checked again when the form is submitted.',

  /**
   * The stamp's own two strings, drawn inside the mark once a transaction
   * confirms.
   *
   * `stampTitle.document` must **not** claim the proposal was accepted. A
   * confirmed transaction says nothing about whether a voting passed, and a
   * stamp reading "approved" would be the most consequential mislabel in the
   * application — the more so now that it looks official.
   *
   * `stampNotice.disclaimer` says the opposite of what a stamp implies: that it
   * proves nothing, and that the hash printed above it is what can be checked.
   * Anyone can put a mark like this on any PDF.
   */
  'stampTitle.document': 'transaction record',
  'stampNotice.disclaimer':
    'This mark is not proof. Check the transaction hash above against the network.',

  /** The application's own name, which the whitepaper already supplies. */
  brand: 'Zarya',

  // ---------------------------------------------------------------------------
  // The matrix reference report. A different document: no fields, landscape, and
  // the one page a voter reads *before* filling anything in.
  // ---------------------------------------------------------------------------

  'reportTitle.document': 'matrix reference',

  'reportSection.axes': 'axis inventory',
  'reportSection.themes': 'themes, by column',
  'reportSection.statements': 'statements, by row',
  'reportSection.cells': 'populated cells',

  /**
   * Column headers, drawn at 7pt in the narrowest column on the page. Short
   * nouns only — `wording:check` refuses anything wider, because at this size a
   * header running into its neighbour reads as one meaningless word.
   */
  'reportColumn.x': 'column (x)',
  'reportColumn.y': 'row (y)',
  'reportColumn.statement': 'statement',
  'reportColumn.organ': 'owning organ',
  'reportColumn.constraints': 'permitted values',
  'reportColumn.value': 'current value',
  'reportColumn.author': 'author',
  'reportColumn.recorded': 'recorded',
  'reportColumn.samples': 'records',
  /**
   * The axis tables reuse `reportColumn.x` and `.y` for their coordinate
   * column rather than having a generic word of their own: a member reading
   * «столбец» in the theme table and something else in the cell table would
   * have to work out that they are the same axis.
   */
  'reportColumn.label': 'wording',
  'reportColumn.confirmation': 'checked against the contract',

  /** The staleness stamp, drawn as `label: value` so no text is interpolated. */
  'reportMeta.block': 'block',
  'reportMeta.readAt': 'time of that block',
  'reportMeta.indexedThrough': 'events indexed through block',

  /** The words that stand in a table cell where a value could not be stated. */
  'reportStatus.unread': 'not read',
  'reportStatus.unbound': 'not bound',
  'reportStatus.unset': 'not set',
  'reportStatus.noValue': 'no value yet',
  'reportStatus.confirmed': 'confirmed',
  'reportStatus.differs': 'differs on the contract',
  'reportStatus.absent': 'not on the contract',
  'reportStatus.decimals': 'decimal places',
  'reportStatus.anyCategory': 'no category permitted yet',

  'reportSentence.purpose':
    'Copy the coordinates from this sheet onto a voting form. Do not copy anything else.',
  'reportSentence.staleness':
    'The matrix changes whenever a voting is executed, so this sheet describes only the block named above.',
  'reportSentence.validation':
    'The application checks coordinates again when a form is submitted. A refusal there means the matrix has changed, not that something is broken.',
  'reportSentence.notAuthoritative':
    'This is a printed reference, not a record. The contract is the only authority.',
  'reportSentence.emptyMatrix':
    'No cell has been populated yet. Use the axis inventory to propose the first value.',
  'reportSentence.noAxes':
    'No theme or statement has been set yet. A value cannot be proposed until a theme exists for its column and a statement for its row.',
  'reportSentence.degraded':
    'Fields marked as not read could not be retrieved from the contract. The coordinates beside them are still correct.',
  'reportSentence.indexBehind':
    'The event index has not caught up to the block above, so a cell created since then is missing from this sheet.',
  'reportSentence.ambiguous':
    'A coordinate bound in both matrices is listed under each, because nothing distinguishes which one a value was written to.',
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

/** The six facts a stamp states, keyed by the schema key each names. */
export const RECEIPT_LABELS = group('receipt');

export const META_LABELS = group('meta');

export const SECTION_LABELS = {
  /** The block the application filled in. Drawn text, not fields. */
  context: labelFor('section.context'),
  /** The block the member fills in — the only widgets on the page. */
  input: labelFor('section.input'),
} as const;

export const SENTENCES = {
  instruction: labelFor('sentence.instruction'),
  coordinateDisclosure: labelFor('sentence.coordinateDisclosure'),
} as const;

export const BRAND = labelFor('brand');

/** The stamp's two strings. See their slots' own note. */
export const STAMP_TITLE = labelFor('stampTitle.document');
export const STAMP_NOTICE = labelFor('stampNotice.disclaimer');

/** The matrix reference's own groups. Same derivation, different document. */
export const REPORT_TITLE = labelFor('reportTitle.document');
export const REPORT_SECTIONS = group('reportSection');
export const REPORT_COLUMNS = group('reportColumn');
export const REPORT_META = group('reportMeta');
export const REPORT_STATUS = group('reportStatus');
export const REPORT_SENTENCES = group('reportSentence');

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
