import { MATRIX_KINDS, type MatrixKind } from '../../domain/matrix/matrix';
import type { AxisInventoryEntry, MatrixReport, ReportRow } from '../../domain/matrix/matrixReport';
import {
  BRAND,
  OPTION_LABELS,
  REPORT_COLUMNS,
  REPORT_META,
  REPORT_SECTIONS,
  REPORT_SENTENCES,
  REPORT_STATUS,
  REPORT_TITLE,
  type Label,
  labelText,
} from './formLabels';
import {
  AXIS_COLUMNS,
  BOTTOM,
  CELL_COLUMNS,
  CONTENT_WIDTH,
  LOGO,
  MARGIN,
  PAGE,
  ROW,
  TYPE,
  columnOffsets,
  formatChainTime,
  shortenAddress,
  shortenHash,
  totalWidth,
} from './reportLayout';

/**
 * Laying the report out, as data rather than as ink.
 *
 * Split from the renderer because with an embedded subset font `drawText` writes
 * **glyph identifiers**, not characters — so once a string is in a PDF content
 * stream there is no way to assert that it is the string that was meant without
 * a full text extractor. Every interesting property of this document is about
 * *what it says and where*: that the staleness stamp is on every page, that a
 * coordinate survives a failed read, that a hash is shown rather than a guessed
 * label, that nothing lands outside the margins. All of those are checkable here
 * and effectively uncheckable one layer down.
 *
 * So this module decides the layout and the wording, and the renderer's only job
 * is to turn a list of positioned strings into a page. There is nothing to
 * decide left in it.
 *
 * Measurement is injected because it is the one thing composition cannot know:
 * how wide «Расходы» is at 7.5pt is a property of PT Sans. Truncation is
 * measured rather than counted for exactly that reason.
 */

/** How wide `text` is, in the face and size it will be drawn at. */
export type Measure = (text: string, size: number, bold: boolean) => number;

/**
 * Three tones, not a palette.
 *
 * `warn` is the load-bearing one: it marks a field that could **not** be read,
 * and a reader has to be able to tell that from a field that is genuinely empty
 * — which is `muted`. Colour is the renderer's business, the distinction is not.
 */
export type Tone = 'ink' | 'muted' | 'warn';

export interface ComposedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly bold: boolean;
  readonly tone: Tone;
}

export interface ComposedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ComposedRule {
  readonly y: number;
  readonly from: number;
  readonly to: number;
}

export interface ComposedPage {
  readonly texts: readonly ComposedText[];
  readonly rects: readonly ComposedRect[];
  readonly rules: readonly ComposedRule[];
  /** The logo's box, top-right. */
  readonly logo: ComposedRect;
}

/** An em dash: a field with nothing to hold, as opposed to one that failed. */
export const NOTHING = '—';

export function composeMatrixReport(
  report: MatrixReport,
  measure: Measure,
): readonly ComposedPage[] {
  return new Composer(report, measure).compose();
}

interface MutablePage {
  readonly texts: ComposedText[];
  readonly rects: ComposedRect[];
  readonly rules: ComposedRule[];
  logo: ComposedRect;
}

const LOGO_BOX: ComposedRect = {
  x: PAGE.width - MARGIN - LOGO.size,
  y: PAGE.height - MARGIN - LOGO.size,
  width: LOGO.size,
  height: LOGO.size,
};

/**
 * The table currently being emitted, so a page break can resume it.
 *
 * Without this, a table that runs past the bottom of a sheet continues onto the
 * next one as unlabelled columns of numbers — and on this document those columns
 * are coordinates, which is the worst possible thing to leave unlabelled.
 */
interface ActiveTable {
  readonly columns: readonly { readonly width: number }[];
  readonly headers: readonly string[];
  /** The `column N · theme` line, redrawn so a continuation sheet says where it is. */
  readonly group: string | undefined;
}

class Composer {
  private readonly pages: MutablePage[] = [];
  private page: MutablePage;
  private y = PAGE.height - MARGIN;
  private activeTable: ActiveTable | undefined;

  constructor(
    private readonly report: MatrixReport,
    private readonly measure: Measure,
  ) {
    this.page = { texts: [], rects: [], rules: [], logo: LOGO_BOX };
    this.pages.push(this.page);
    this.y = this.header();
  }

  compose(): readonly ComposedPage[] {
    this.notices();
    this.axisInventory();
    this.cells();
    return this.pages;
  }

  // -------------------------------------------------------------- pagination

  /**
   * A fresh sheet, with everything a continuation sheet owes its reader.
   *
   * The stamp, then the column group being continued, then the column headers.
   * `drawTableHead` deliberately does **not** reserve space: it is called from
   * here, and a reservation inside a page break would re-enter the break.
   */
  private startPage(): void {
    this.page = { texts: [], rects: [], rules: [], logo: LOGO_BOX };
    this.pages.push(this.page);
    this.y = this.header();
    if (this.activeTable !== undefined) this.drawTableHead(this.activeTable);
  }

  /** Guarantees `needed` points remain above the bottom margin. */
  private reserve(needed: number): void {
    if (this.y - needed < BOTTOM) this.startPage();
  }

  private advance(amount: number): number {
    this.y -= amount;
    return this.y;
  }

  // ------------------------------------------------------------------ writing

  private write(
    text: string,
    options: {
      x: number;
      y: number;
      size: number;
      bold?: boolean;
      tone?: Tone;
      /** Truncates with an ellipsis rather than overrunning the next column. */
      maxWidth?: number;
    },
  ): void {
    const bold = options.bold ?? false;
    this.page.texts.push({
      text:
        options.maxWidth === undefined
          ? text
          : fit(text, options.size, bold, options.maxWidth, this.measure),
      x: options.x,
      y: options.y,
      size: options.size,
      bold,
      tone: options.tone ?? 'ink',
    });
  }

  /**
   * The running header, redrawn on every sheet, returning the `y` to continue at.
   *
   * The block number and chain time are on **every** page because a printed
   * stack gets separated, and a loose sheet with no stamp is one whose age
   * nobody can establish.
   */
  private header(): number {
    const { readAt } = this.report;
    let y = PAGE.height - MARGIN - TYPE.brand;

    this.write(labelText(BRAND), { x: MARGIN, y, size: TYPE.brand, bold: true });

    y -= TYPE.title + 6;
    this.write(labelText(REPORT_TITLE), { x: MARGIN, y, size: TYPE.title, bold: true });

    // Label/value pairs rather than a sentence with a number in it, so the
    // wording file never needs a placeholder and a translator never has to
    // preserve one.
    y -= TYPE.stamp + 8;
    const stamp = [
      `${labelText(REPORT_META.block)}: ${readAt.blockNumber}`,
      `${labelText(REPORT_META.readAt)}: ${formatChainTime(readAt.timestamp)}`,
    ];
    if (this.report.indexBehindBy !== undefined) {
      stamp.push(
        `${labelText(REPORT_META.indexedThrough)}: ${readAt.blockNumber - this.report.indexBehindBy}`,
      );
    }
    this.write(stamp.join('   ·   '), { x: MARGIN, y, size: TYPE.stamp, maxWidth: CONTENT_WIDTH });

    y -= 6;
    this.page.rules.push({ y, from: MARGIN, to: MARGIN + CONTENT_WIDTH });
    return y - ROW.headerGap;
  }

  private sentence(label: Label, tone: Tone = 'muted'): void {
    // A sentence is never inside a table, so no head has to be resumed after it.
    this.activeTable = undefined;
    this.reserve(TYPE.sentence + ROW.sentenceGap);
    this.advance(TYPE.sentence + ROW.sentenceGap);
    this.write(labelText(label), {
      x: MARGIN,
      y: this.y,
      size: TYPE.sentence,
      tone,
      maxWidth: CONTENT_WIDTH,
    });
  }

  private heading(text: string, size: number = TYPE.sectionHeading): void {
    this.activeTable = undefined;
    this.reserve(ROW.sectionGap + size + ROW.headerHeight);
    this.advance(ROW.sectionGap + size);
    this.write(text, { x: MARGIN, y: this.y, size, bold: true });
  }

  /**
   * The standing notices, then the conditional ones.
   *
   * Order is deliberate: what to do with the sheet, then why it expires, then
   * that a later refusal is expected rather than a fault. The third stops a
   * voter concluding the application is broken when preflight rejects a
   * coordinate they copied correctly a month ago.
   */
  private notices(): void {
    this.sentence(REPORT_SENTENCES.purpose, 'ink');
    this.sentence(REPORT_SENTENCES.staleness);
    this.sentence(REPORT_SENTENCES.validation);
    this.sentence(REPORT_SENTENCES.notAuthoritative);

    if (this.report.indexBehindBy !== undefined) this.sentence(REPORT_SENTENCES.indexBehind, 'warn');
    if (this.report.degradedRows > 0) this.sentence(REPORT_SENTENCES.degraded, 'warn');
    if (hasAmbiguousCoordinate(this.report)) this.sentence(REPORT_SENTENCES.ambiguous);
  }

  // ---------------------------------------------------------- axis inventory

  /**
   * Themes and statements, per matrix, in a section of their own.
   *
   * Not an appendix. It is what a voter needs to propose a value at a coordinate
   * with no cell yet — the ordinary case on a young matrix — and the only place
   * a long statement's full wording appears.
   */
  private axisInventory(): void {
    this.heading(labelText(REPORT_SECTIONS.axes));

    const populated = MATRIX_KINDS.filter(
      (kind) =>
        this.report.axes[kind].themes.length > 0 || this.report.axes[kind].statements.length > 0,
    );
    if (populated.length === 0) {
      this.sentence(REPORT_SENTENCES.noAxes, 'warn');
      return;
    }

    for (const kind of populated) {
      const inventory = this.report.axes[kind];
      this.heading(matrixName(kind), TYPE.groupHeading);

      if (inventory.themes.length > 0) {
        this.heading(labelText(REPORT_SECTIONS.themes), TYPE.groupHeading);
        this.axisTable(labelText(REPORT_COLUMNS.x), inventory.themes);
      }
      if (inventory.statements.length > 0) {
        this.heading(labelText(REPORT_SECTIONS.statements), TYPE.groupHeading);
        this.axisTable(labelText(REPORT_COLUMNS.y), inventory.statements);
      }
    }
  }

  private axisTable(coordinateHeader: string, entries: readonly AxisInventoryEntry[]): void {
    this.openTable(AXIS_COLUMNS, [
      coordinateHeader,
      labelText(REPORT_COLUMNS.label),
      labelText(REPORT_COLUMNS.confirmation),
    ]);

    for (const entry of entries) {
      this.tableRow(AXIS_COLUMNS, entry.coordinate, [
        { text: entry.coordinate.toString() },
        { text: entry.text },
        confirmationCell(entry),
      ]);
    }
    this.activeTable = undefined;
  }

  // ------------------------------------------------------------------- cells

  /**
   * The populated cells, grouped by matrix and then by column.
   *
   * The theme is printed once as the heading over its column's rows rather than
   * on every one. It is constant down the column, and repeating it would spend
   * ~165pt of every line restating it — the width that pays for the author and
   * the timestamp being legible.
   *
   * **This relies on the model's rows being sorted by `x`**, which
   * `assembleMatrixReport` guarantees. Grouping is done by watching `x` change
   * rather than by bucketing, so unsorted rows would emit a fresh group heading
   * and a fresh set of column headers per row — roughly four times the paper for
   * the same content. Cheap to depend on and expensive to get wrong, so there is
   * a test that a column's rows produce exactly one heading.
   */
  private cells(): void {
    this.heading(labelText(REPORT_SECTIONS.cells));

    if (this.report.rows.length === 0) {
      this.sentence(REPORT_SENTENCES.emptyMatrix, 'warn');
      return;
    }

    for (const kind of MATRIX_KINDS) {
      const rows = this.report.rows.filter((row) => row.matrix === kind);
      if (rows.length === 0) continue;

      this.heading(matrixName(kind), TYPE.groupHeading);

      let column: bigint | undefined;
      for (const row of rows) {
        if (row.at.x !== column) {
          column = row.at.x;
          this.openTable(
            CELL_COLUMNS,
            CELL_COLUMNS.map((definition) => labelText(REPORT_COLUMNS[definition.slot])),
            `${labelText(REPORT_COLUMNS.x)} ${row.at.x}   ·   ${axisCell(row.theme).text}`,
          );
        }
        this.cellRow(row);
      }
      this.activeTable = undefined;
    }
  }

  private cellRow(row: ReportRow): void {
    const unread = { text: labelText(REPORT_STATUS.unread), tone: 'warn' as Tone };
    const { value } = row;

    this.tableRow(CELL_COLUMNS, row.at.y, [
      { text: row.at.y.toString() },
      axisCell(row.statement),
      organCell(row),
      row.unread.includes('CELL') ? unread : { text: constraintsText(row) },
      valueCell(row),
      { text: value.kind === 'SET' ? shortenAddress(value.value.author) : NOTHING },
      { text: value.kind === 'SET' ? formatChainTime(value.value.recordedAt) : NOTHING },
      { text: row.sampleCount === undefined ? NOTHING : row.sampleCount.toString() },
    ]);
  }

  // ------------------------------------------------------------------ tables

  /**
   * Starts a table, reserving room for its head **and its first row**.
   *
   * Reserving the first row too is what stops a header landing at the foot of a
   * sheet with its rows on the next — which reads as an empty table followed by
   * anonymous numbers.
   */
  private openTable(
    columns: readonly { readonly width: number }[],
    headers: readonly string[],
    group?: string,
  ): void {
    const table: ActiveTable = { columns, headers, group };
    const needed =
      (group === undefined ? 0 : ROW.groupGap + TYPE.groupHeading) +
      ROW.headerHeight +
      ROW.height;

    if (this.y - needed < BOTTOM) {
      // The break draws the head itself, from `activeTable`, so drawing it again
      // here would stack two copies at the top of the new sheet.
      this.activeTable = table;
      this.startPage();
      return;
    }
    this.activeTable = table;
    this.drawTableHead(table);
  }

  /** Draws a group line and column headers at the current `y`. Never reserves. */
  private drawTableHead(table: ActiveTable): void {
    if (table.group !== undefined) {
      this.advance(ROW.groupGap + TYPE.groupHeading);
      this.write(table.group, {
        x: MARGIN,
        y: this.y,
        size: TYPE.groupHeading,
        bold: true,
        maxWidth: CONTENT_WIDTH,
      });
    }

    const y = this.advance(ROW.headerHeight);
    const offsets = columnOffsets(table.columns);
    this.page.rects.push({
      x: MARGIN,
      y: y - 3,
      width: totalWidth(table.columns),
      height: ROW.headerHeight,
    });
    table.headers.forEach((header, index) => {
      this.write(header, {
        x: offsets[index] + 2,
        y,
        size: TYPE.columnHeader,
        bold: true,
        maxWidth: table.columns[index].width - 4,
      });
    });
  }

  /**
   * One row, with its coordinate guaranteed complete.
   *
   * **A coordinate is never truncated.** Every other cell may be cut to its
   * column — a statement's full wording is in the axis inventory, an author is
   * being recognised rather than copied — but the coordinate is the one thing on
   * this sheet a voter transcribes onto a form, and a truncated one addresses a
   * different real cell. `uint256` allows 78 digits, which no column can hold, so
   * an oversized coordinate is printed **on its own full-width line above the
   * row** and the cell keeps the ellipsised form as a visible pointer to it.
   * Rare, and the alternative is a wrong transaction.
   */
  private tableRow(
    columns: readonly { readonly width: number }[],
    coordinate: bigint,
    values: readonly { readonly text: string; readonly tone?: Tone }[],
  ): void {
    const digits = coordinate.toString();
    const oversized = this.measure(digits, TYPE.cell, false) > columns[0].width - 4;

    this.reserve(oversized ? ROW.height * 2 : ROW.height);

    if (oversized) {
      const y = this.advance(ROW.height);
      this.write(digits, { x: MARGIN, y, size: TYPE.cell, maxWidth: CONTENT_WIDTH });
    }

    const y = this.advance(ROW.height);
    const offsets = columnOffsets(columns);
    values.forEach((value, index) => {
      this.write(value.text, {
        x: offsets[index] + 2,
        y,
        size: TYPE.cell,
        tone: value.tone,
        maxWidth: columns[index].width - 4,
      });
    });
  }
}

/** A coordinate listed under both matrices — the reason the notice exists. */
export const hasAmbiguousCoordinate = (report: MatrixReport): boolean => {
  const seen = new Set<string>();
  for (const row of report.rows) {
    const key = `${row.at.x},${row.at.y}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
};

const confirmationCell = (entry: AxisInventoryEntry): { text: string; tone?: Tone } => {
  switch (entry.confirmation.kind) {
    case 'MATCHES':
      return { text: labelText(REPORT_STATUS.confirmed) };
    case 'DIFFERS':
      // Both texts, because the disagreement *is* the finding: the index has not
      // seen a later voting, or it is projecting the other deployment.
      return {
        text: `${labelText(REPORT_STATUS.differs)}: ${entry.confirmation.onChain}`,
        tone: 'warn',
      };
    case 'ABSENT_ON_CHAIN':
      return { text: labelText(REPORT_STATUS.absent), tone: 'warn' };
    case 'UNREAD':
      return { text: labelText(REPORT_STATUS.unread), tone: 'warn' };
  }
};

const organCell = (row: ReportRow): { text: string; tone?: Tone } => {
  switch (row.organ.kind) {
    case 'LABELLED':
      return { text: row.organ.label };
    case 'UNBOUND':
      return { text: labelText(REPORT_STATUS.unbound), tone: 'muted' };
    case 'UNRESOLVED':
      // The hash verbatim rather than a guess. An organ outside the locally
      // enumerated table is a real organ this client cannot name, and naming it
      // wrongly would attribute a cell to the wrong body.
      return { text: shortenHash(row.organ.organ) };
    case 'UNREAD':
      return { text: labelText(REPORT_STATUS.unread), tone: 'warn' };
  }
};

const valueCell = (row: ReportRow): { text: string; tone?: Tone } => {
  switch (row.value.kind) {
    case 'UNREAD':
      return { text: labelText(REPORT_STATUS.unread), tone: 'warn' };
    case 'NONE':
      return { text: labelText(REPORT_STATUS.noValue), tone: 'muted' };
    case 'SET': {
      // A categorical value shows the category's own name beside the number,
      // since the number alone is not what anyone voted on.
      const name = row.value.categoryName;
      return {
        text:
          name !== undefined && name.kind === 'SET'
            ? `${row.value.text} ${name.text}`
            : row.value.text,
      };
    }
  }
};

const constraintsText = (row: ReportRow): string => {
  if (row.matrix === 'NUMERICAL') {
    return row.decimals === undefined
      ? labelText(REPORT_STATUS.unbound)
      : `${labelText(REPORT_STATUS.decimals)}: ${row.decimals}`;
  }
  if (row.categories.length === 0) return labelText(REPORT_STATUS.anyCategory);
  return row.categories
    .map((entry) => {
      const { name } = entry;
      if (name === undefined) return `${entry.category} (${labelText(REPORT_STATUS.unread)})`;
      return name.kind === 'SET' ? `${entry.category} ${name.text}` : entry.category.toString();
    })
    .join(' · ');
};

const axisCell = (label: ReportRow['theme']): { text: string; tone?: Tone } => {
  if (label === undefined) return { text: labelText(REPORT_STATUS.unread), tone: 'warn' };
  return label.kind === 'SET'
    ? { text: label.text }
    : { text: labelText(REPORT_STATUS.unset), tone: 'muted' };
};

/**
 * The form's own words for the two matrices, reused rather than restated — a
 * member who read «ЧИСЛОВАЯ» on a form should meet the same word here.
 */
const matrixName = (kind: MatrixKind): string => labelText(OPTION_LABELS[kind]);

/**
 * Truncates to `maxWidth` with an ellipsis, measured in the real font.
 *
 * Measured rather than counted: Russian at 7.5pt averages roughly 3.5pt per
 * character, but «шщ» and «іі» are nothing alike, so a character budget would
 * overrun on wide text and waste a third of the column on narrow text.
 *
 * The ellipsis is one character rather than three dots, so a truncation reads as
 * a truncation and not as a sentence that happened to end in a full stop.
 */
export function fit(
  text: string,
  size: number,
  bold: boolean,
  maxWidth: number,
  measure: Measure,
): string {
  if (measure(text, size, bold) <= maxWidth) return text;

  const ellipsis = '…';
  const budget = maxWidth - measure(ellipsis, size, bold);
  if (budget <= 0) return '';

  // Linear from the end rather than a bisection: these strings are short, and
  // the loop is obviously correct where an off-by-one in a binary search is the
  // kind of bug that shows on one string in a thousand.
  let cut = text.length - 1;
  while (cut > 0 && measure(text.slice(0, cut), size, bold) > budget) cut -= 1;
  return `${text.slice(0, cut)}${ellipsis}`;
}
