/**
 * Landscape A4 geometry for the matrix reference, as numbers with reasons.
 *
 * Separate from `templateLayout.ts` rather than parameterised by orientation.
 * The two documents share a page size and nothing else: a form is a column of
 * labelled boxes a member writes in, and this is a wide table nobody writes on.
 * Folding them together would mean every constant carrying an "if it is the
 * report" clause.
 *
 * **Landscape**, because the table has eight columns and a statement is a
 * sentence. Portrait would either truncate the statement — the field that tells a
 * voter what the row *means* — or wrap it, and nothing here wraps.
 *
 * Points throughout, 72 to the inch, A4 because the party is Russian.
 */

/** 297 × 210 mm. The same sheet as a form, turned. */
export const PAGE = { width: 841.89, height: 595.28 } as const;

/** ~15 mm, as the forms use: what every consumer printer can reach. */
export const MARGIN = 42;

export const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

export const TYPE = {
  brand: 14,
  /** The document's own title. */
  title: 12,
  sectionHeading: 10,
  /** A theme, printed once as the heading over the rows in its column. */
  groupHeading: 9,
  columnHeader: 7,
  cell: 7.5,
  sentence: 8,
  /** The staleness stamp, which is read once and must not dominate the page. */
  stamp: 7.5,
} as const;

export const ROW = {
  /** One table row. 11pt fits 7.5pt text with air above and below. */
  height: 11,
  headerHeight: 13,
  sectionGap: 14,
  groupGap: 8,
  sentenceGap: 3,
  /** Between the header block and the first section. */
  headerGap: 10,
} as const;

/** Square, top-right, as on a form. */
export const LOGO = { size: 30 } as const;

/**
 * The cell table's columns, in print order.
 *
 * Widths sum to exactly {@link CONTENT_WIDTH}, and the narrowest is 70pt — which
 * is not an accident but the constraint the wording checker enforces. A column
 * header that does not fit would run into its neighbour, and at 7pt that reads
 * as one long meaningless word rather than as a layout bug.
 *
 * `theme` is absent on purpose. It is constant down a column, so it is printed
 * **once** as a group heading rather than repeated on every row: repeating it
 * costs roughly 140pt of every line to say the same thing, which is the width
 * that pays for `author` and `recorded` being legible.
 */
export const CELL_COLUMNS = [
  { slot: 'y', width: 70 },
  { slot: 'statement', width: 165 },
  { slot: 'organ', width: 92 },
  { slot: 'constraints', width: 105 },
  { slot: 'value', width: 85 },
  { slot: 'author', width: 80 },
  { slot: 'recorded', width: 90 },
  { slot: 'samples', width: 70 },
] as const;

/**
 * The axis inventory's columns.
 *
 * Wider than the cell table's because there are three of them and the label is
 * the point: a theme or statement is the party's own sentence and truncating it
 * would defeat the section.
 */
export const AXIS_COLUMNS = [
  { slot: 'coordinate', width: 70 },
  { slot: 'label', width: 430 },
  { slot: 'confirmation', width: 257 },
] as const;

/** The narrowest column any header is drawn in, which is the wording limit. */
export const NARROWEST_COLUMN = Math.min(
  ...CELL_COLUMNS.map((column) => column.width),
  ...AXIS_COLUMNS.map((column) => column.width),
);

/** Left edge of each column, cumulative from the margin. */
export const columnOffsets = (
  columns: readonly { readonly width: number }[],
): readonly number[] => {
  const offsets: number[] = [];
  let x = MARGIN;
  for (const column of columns) {
    offsets.push(x);
    x += column.width;
  }
  return offsets;
};

export const totalWidth = (columns: readonly { readonly width: number }[]): number =>
  columns.reduce((sum, column) => sum + column.width, 0);

/**
 * The lowest `y` a row may start at and still fit above the bottom margin.
 *
 * Pagination lives in the composer rather than in a cursor object here, because
 * unlike a form this document *expects* to paginate: a matrix of any size runs to
 * several sheets, and a continuation sheet has to redraw the staleness stamp,
 * the column group it is continuing, and the column headers. A cursor with a
 * page-break callback cannot do that without the callback re-entering the
 * reservation logic that called it.
 */
export const BOTTOM = MARGIN;

/**
 * A chain timestamp as printed text.
 *
 * `DD.MM.YYYY HH:MM UTC` — Russian date order, and **UTC stated rather than
 * converted**. A block timestamp rendered in the reader's local zone would be a
 * different string on two machines printing the same block, and the one thing
 * this stamp exists to do is identify the block unambiguously.
 *
 * Built from the explicit UTC getters rather than `toLocaleString`, so the output
 * does not depend on the host's locale or its ICU data.
 */
export const formatChainTime = (seconds: number): string => {
  const at = new Date(seconds * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${at.getUTCFullYear()} ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
  );
};

/**
 * An address shortened for a table cell, keeping both ends.
 *
 * A full address is 42 characters and would need ~150pt at 7.5pt, which the
 * author column cannot give without taking it from the statement. Both ends are
 * kept because the middle is what an eye skips anyway, and an author is being
 * *recognised* here rather than transcribed — the form never asks anyone to copy
 * one off this sheet.
 */
export const shortenAddress = (address: string): string =>
  address.length <= 16 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`;

/**
 * An organ hash shortened the same way, for a cell the reverse table could not
 * name. Kept recognisable rather than complete, for the same reason.
 */
export const shortenHash = (hash: string): string =>
  hash.length <= 18 ? hash : `${hash.slice(0, 10)}…${hash.slice(-4)}`;
