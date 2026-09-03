import { describe, expect, it } from 'vitest';
import type { MatrixKind } from '../../domain/matrix/matrix';
import type { AxisInventory, MatrixReport, ReportRow } from '../../domain/matrix/matrixReport';
import { bytes32, evmAddress, unixSeconds } from '../../domain/primitives';
import {
  type ComposedPage,
  type Measure,
  composeMatrixReport,
  fit,
} from './composeMatrixReport';
import { REPORT_COLUMNS, REPORT_SENTENCES, REPORT_STATUS, labelText } from './formLabels';
import {
  AXIS_COLUMNS,
  CELL_COLUMNS,
  CONTENT_WIDTH,
  MARGIN,
  NARROWEST_COLUMN,
  PAGE,
  columnOffsets,
  formatChainTime,
  shortenAddress,
  totalWidth,
} from './reportLayout';

/**
 * What the document says and where, which is the half worth testing.
 *
 * Composition is separated from rendering because a subset embedded font turns
 * every drawn string into glyph identifiers, so once this is a PDF there is no
 * way to assert that the coordinate on the page is the coordinate that was
 * meant. Everything that matters about a reference sheet — that the stamp is on
 * every sheet, that a coordinate survives a failed read, that a hash is shown
 * rather than a guess, that nothing lands off the paper — is checkable here.
 */

const ORGAN = bytes32(`0x${'11'.repeat(32)}`);
const UNLISTED = bytes32(`0x${'ab'.repeat(32)}`);
const AUTHOR = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');
/** 27 August 2026, 14:00 UTC. */
const READ_AT = { blockNumber: 8_642_197n, timestamp: unixSeconds(1_787_839_200) };

/**
 * A measurer with no font: 4pt per character at 10pt, scaled.
 *
 * Deliberately crude and deliberately *not* PT Sans. These tests are about
 * layout decisions, and using the real font here would make an assertion about
 * where a column starts depend on a glyph table. The real measurer is exercised
 * by the renderer's own test.
 */
const measure: Measure = (text, size) => text.length * 0.4 * size;

const emptyAxes = (): { [K in MatrixKind]: AxisInventory } => ({
  CATEGORICAL: { themes: [], statements: [] },
  NUMERICAL: { themes: [], statements: [] },
});

const row = (overrides: Partial<ReportRow> = {}): ReportRow => ({
  matrix: 'CATEGORICAL',
  at: { x: 3n, y: 7n },
  theme: { kind: 'SET', text: 'Бюджет партии' },
  statement: { kind: 'SET', text: 'Расходы' },
  organ: { kind: 'LABELLED', organ: ORGAN, label: '74.СОВ' },
  binding: { kind: 'BOUND', organ: ORGAN },
  categories: [
    { category: 1n, name: { kind: 'SET', text: 'ЗА' } },
    { category: 2n, name: { kind: 'SET', text: 'ПРОТИВ' } },
  ],
  decimals: undefined,
  value: {
    kind: 'SET',
    text: '1',
    raw: 1n,
    value: { kind: 'SET', value: 1n, author: AUTHOR, recordedAt: unixSeconds(1_755_000_000) },
    categoryName: { kind: 'SET', text: 'ЗА' },
  },
  sampleCount: 3n,
  unread: [],
  ...overrides,
});

const report = (overrides: Partial<MatrixReport> = {}): MatrixReport => ({
  readAt: READ_AT,
  indexBehindBy: undefined,
  rows: [],
  axes: emptyAxes(),
  degradedRows: 0,
  empty: true,
  ...overrides,
});

const compose = (overrides: Partial<MatrixReport> = {}) =>
  composeMatrixReport(report(overrides), measure);

const allText = (pages: readonly ComposedPage[]): readonly string[] =>
  pages.flatMap((page) => page.texts.map((item) => item.text));

const textOn = (page: ComposedPage): readonly string[] => page.texts.map((item) => item.text);

describe('the staleness stamp', () => {
  it('names the block and the chain time of that block', () => {
    const pages = compose();

    expect(textOn(pages[0]).some((text) => text.includes('8642197'))).toBe(true);
    expect(formatChainTime(READ_AT.timestamp)).toBe('27.08.2026 14:00 UTC');
    expect(textOn(pages[0]).some((text) => text.includes('27.08.2026 14:00 UTC'))).toBe(true);
  });

  it('appears on every page, because a printed stack gets separated', () => {
    // A loose sheet with no stamp is a sheet whose age nobody can establish.
    const rows = Array.from({ length: 200 }, (_, index) =>
      row({ at: { x: BigInt(index % 5), y: BigInt(index) } }),
    );
    const pages = compose({ rows, empty: false });

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(textOn(page).some((text) => text.includes('8642197'))).toBe(true);
    }
  });

  it('repeats the column headers on every page a table continues onto', () => {
    // Without them a continuation sheet is eight unlabelled columns of numbers —
    // and on this document those columns are coordinates, which is the worst
    // thing on the page to leave unlabelled. One theme and 200 rows, so the
    // table spans several sheets under a single group heading.
    const rows = Array.from({ length: 200 }, (_, index) =>
      row({ at: { x: 3n, y: BigInt(index) } }),
    );
    const pages = compose({ rows, empty: false });

    const pagesWithRows = pages.filter((page) =>
      page.texts.some((item) => item.size === 7.5 && /^\d+$/.test(item.text)),
    );
    expect(pagesWithRows.length).toBeGreaterThan(1);
    for (const page of pagesWithRows) {
      const headers = page.texts.filter((item) => item.size === 7);
      expect(headers.map((item) => item.text)).toContain(labelText(REPORT_COLUMNS.y));
      // The shaded band behind a header row.
      expect(page.rects.length).toBeGreaterThan(0);
    }
  });

  it('repeats the column group, so a continuation sheet says which column it is', () => {
    // «column 3 · Бюджет партии» at the top of every sheet the column runs onto.
    // Otherwise a reader has to page backwards to find out what x they are in.
    const rows = Array.from({ length: 200 }, (_, index) =>
      row({ at: { x: 3n, y: BigInt(index) } }),
    );
    const pages = compose({ rows, empty: false });
    const withRows = pages.filter((page) =>
      page.texts.some((item) => item.size === 7.5 && /^\d+$/.test(item.text)),
    );

    expect(withRows.length).toBeGreaterThan(1);
    for (const page of withRows) {
      expect(textOn(page).some((text) => text.includes('Бюджет партии'))).toBe(true);
    }
  });

  it('carries the indexed-through block only when the index is behind', () => {
    expect(textOn(compose()[0]).join(' ')).not.toContain('8642147');

    const behind = compose({ indexBehindBy: 50n });
    expect(textOn(behind[0]).some((text) => text.includes('8642147'))).toBe(true);
  });
});

describe('the notices', () => {
  it('leads with what to do with the sheet, then why it expires', () => {
    const texts = allText(compose());
    const order = [
      labelText(REPORT_SENTENCES.purpose),
      labelText(REPORT_SENTENCES.staleness),
      labelText(REPORT_SENTENCES.validation),
      labelText(REPORT_SENTENCES.notAuthoritative),
    ].map((sentence) => texts.indexOf(sentence));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
  });

  it('warns that the index is behind only when it is', () => {
    expect(allText(compose())).not.toContain(labelText(REPORT_SENTENCES.indexBehind));
    expect(allText(compose({ indexBehindBy: 50n }))).toContain(
      labelText(REPORT_SENTENCES.indexBehind),
    );
  });

  it('warns about unread fields only when a row has one', () => {
    expect(allText(compose())).not.toContain(labelText(REPORT_SENTENCES.degraded));
    expect(
      allText(compose({ rows: [row({ unread: ['VALUE'] })], empty: false, degradedRows: 1 })),
    ).toContain(labelText(REPORT_SENTENCES.degraded));
  });

  it('explains a coordinate listed twice only when one is', () => {
    // Reachable: the two matrices are independent mappings over one coordinate
    // space, so (3, 7) can be bound in both and no read separates them.
    const both = [row({ matrix: 'CATEGORICAL' }), row({ matrix: 'NUMERICAL', decimals: 2 })];

    expect(allText(compose({ rows: [row()], empty: false }))).not.toContain(
      labelText(REPORT_SENTENCES.ambiguous),
    );
    expect(allText(compose({ rows: both, empty: false }))).toContain(
      labelText(REPORT_SENTENCES.ambiguous),
    );
  });
});

describe('an empty matrix', () => {
  it('is one real page that says so, not a blank sheet', () => {
    const pages = compose();

    expect(pages).toHaveLength(1);
    expect(allText(pages)).toContain(labelText(REPORT_SENTENCES.emptyMatrix));
    expect(allText(pages)).toContain(labelText(REPORT_SENTENCES.noAxes));
  });

  it('drops the no-axes notice as soon as one theme exists', () => {
    const pages = compose({
      empty: false,
      axes: {
        ...emptyAxes(),
        NUMERICAL: {
          themes: [{ coordinate: 3n, text: 'Бюджет', confirmation: { kind: 'MATCHES' } }],
          statements: [],
        },
      },
    });

    expect(allText(pages)).not.toContain(labelText(REPORT_SENTENCES.noAxes));
    expect(allText(pages)).toContain('Бюджет');
    // Still no cells, and that is a separate statement.
    expect(allText(pages)).toContain(labelText(REPORT_SENTENCES.emptyMatrix));
  });
});

describe('a coordinate is never truncated', () => {
  it('prints a 78-digit y in full on its own line above the row', () => {
    // uint256, and the coordinate is the one thing on the page a voter copies.
    // A truncated one addresses a *different real cell*, so no column width may
    // be allowed to shorten it — it goes on a full-width line instead.
    const huge = (1n << 255n) + 12_345n;
    const pages = compose({ rows: [row({ at: { x: 1n, y: huge } })], empty: false });

    expect(allText(pages)).toContain(huge.toString());
  });

  it('prints an axis coordinate in full too', () => {
    const huge = (1n << 200n) + 7n;
    const pages = compose({
      empty: false,
      axes: {
        ...emptyAxes(),
        CATEGORICAL: {
          themes: [{ coordinate: huge, text: 'Бюджет', confirmation: { kind: 'MATCHES' } }],
          statements: [],
        },
      },
    });

    expect(allText(pages)).toContain(huge.toString());
  });

  it('does not spend a second line on a coordinate that fits', () => {
    // The overflow line is for the pathological case only; a normal matrix uses
    // small coordinates and must not have every row doubled in height.
    const short = compose({ rows: [row({ at: { x: 1n, y: 7n } })], empty: false });
    const sevens = allText(short).filter((text) => text === '7');

    expect(sevens).toHaveLength(1);
  });

  it('keeps the truncated form in the cell as a pointer to the full line', () => {
    // So the row is not left with a blank where its coordinate belongs, which in
    // a table reads as "no value" rather than as "printed above".
    const huge = (1n << 255n) + 12_345n;
    const pages = compose({ rows: [row({ at: { x: 1n, y: huge } })], empty: false });
    const texts = allText(pages);

    expect(texts).toContain(huge.toString());
    expect(texts.some((text) => text.endsWith('…') && huge.toString().startsWith(text.slice(0, 5))))
      .toBe(true);
  });
});

describe('a field that could not be read', () => {
  it('says so in the warning tone and keeps the coordinates beside it', () => {
    const pages = compose({
      rows: [
        row({
          at: { x: 11n, y: 22n },
          organ: { kind: 'UNREAD' },
          statement: undefined,
          value: { kind: 'UNREAD' },
          sampleCount: undefined,
          unread: ['CELL', 'STATEMENT', 'VALUE'],
        }),
      ],
      empty: false,
      degradedRows: 1,
    });

    const texts = allText(pages);
    expect(texts).toContain('22');
    expect(texts).toContain(labelText(REPORT_STATUS.unread));

    const unread = pages
      .flatMap((page) => page.texts)
      .filter((item) => item.text === labelText(REPORT_STATUS.unread));
    expect(unread.length).toBeGreaterThan(0);
    expect(unread.every((item) => item.tone === 'warn')).toBe(true);
  });

  it('is a different tone from a field that is genuinely empty', () => {
    // A reader has to be able to tell "we could not read this" from "there is
    // nothing here". Both are grey-ish on paper and the distinction is the point.
    const pages = compose({
      rows: [row({ value: { kind: 'NONE' } })],
      empty: false,
    });

    const none = pages
      .flatMap((page) => page.texts)
      .find((item) => item.text === labelText(REPORT_STATUS.noValue));
    expect(none?.tone).toBe('muted');
  });
});

describe('an organ the reverse table could not name', () => {
  it('shows the hash rather than a guessed label', () => {
    const pages = compose({
      rows: [row({ organ: { kind: 'UNRESOLVED', organ: UNLISTED } })],
      empty: false,
    });

    expect(allText(pages).some((text) => text.startsWith('0xabababab'))).toBe(true);
  });

  it('distinguishes an unbound cell from an unnameable organ', () => {
    const pages = compose({ rows: [row({ organ: { kind: 'UNBOUND' } })], empty: false });

    expect(allText(pages)).toContain(labelText(REPORT_STATUS.unbound));
  });
});

describe('what a cell row says about its constraints', () => {
  it('lists a categorical cell’s permitted categories with their names', () => {
    const pages = compose({ rows: [row()], empty: false });

    expect(allText(pages)).toContain('1 ЗА · 2 ПРОТИВ');
  });

  it('says no category is permitted yet rather than showing an empty cell', () => {
    // A bound categorical cell with no allowed category cannot take a value, and
    // a blank there reads as "anything goes" — the opposite of the truth.
    const pages = compose({ rows: [row({ categories: [] })], empty: false });

    expect(allText(pages)).toContain(labelText(REPORT_STATUS.anyCategory));
  });

  it('shows a numerical cell’s decimal places', () => {
    const pages = compose({
      rows: [row({ matrix: 'NUMERICAL', decimals: 2, categories: [] })],
      empty: false,
    });

    expect(allText(pages)).toContain(`${labelText(REPORT_STATUS.decimals)}: 2`);
  });

  it('names an individual unread category name without losing the number', () => {
    const pages = compose({
      rows: [row({ categories: [{ category: 5n, name: undefined }], unread: ['CATEGORY_NAME'] })],
      empty: false,
      degradedRows: 1,
    });

    expect(allText(pages).some((text) => text.startsWith('5 ('))).toBe(true);
  });
});

describe('a categorical value', () => {
  it('prints the category’s name beside the number, since the number is not the vote', () => {
    const pages = compose({ rows: [row()], empty: false });

    expect(allText(pages)).toContain('1 ЗА');
  });
});

describe('the theme is a group heading, not a column', () => {
  it('is printed once for a column however many rows sit in it', () => {
    const rows = [1n, 2n, 3n].map((y) => row({ at: { x: 3n, y } }));
    const pages = compose({ rows, empty: false });

    const headings = allText(pages).filter((text) => text.includes('Бюджет партии'));
    expect(headings).toHaveLength(1);
  });

  it('fits a sorted table onto far fewer sheets than an unsorted one', () => {
    // The grouping watches `x` change rather than bucketing, so it depends on
    // `assembleMatrixReport` having sorted the rows. Unsorted, every row gets
    // its own heading and header band — the same content on several times the
    // paper. Measured rather than asserted in a comment.
    const count = 90;
    const sorted = Array.from({ length: count }, (_, index) =>
      row({ at: { x: BigInt(Math.floor(index / 30)), y: BigInt(index) } }),
    );
    const shuffled = Array.from({ length: count }, (_, index) =>
      row({ at: { x: BigInt(index % 3), y: BigInt(index) } }),
    );

    const sortedPages = compose({ rows: sorted, empty: false }).length;
    const shuffledPages = compose({ rows: shuffled, empty: false }).length;

    expect(sortedPages).toBeLessThan(shuffledPages);
    // And a sorted page really does carry a table's worth of rows.
    expect(count / sortedPages).toBeGreaterThan(25);
  });

  it('starts a new heading when the column changes', () => {
    const rows = [
      row({ at: { x: 3n, y: 1n }, theme: { kind: 'SET', text: 'Первая тема' } }),
      row({ at: { x: 4n, y: 1n }, theme: { kind: 'SET', text: 'Вторая тема' } }),
    ];
    const pages = compose({ rows, empty: false });
    const texts = allText(pages);

    expect(texts.some((text) => text.includes('Первая тема'))).toBe(true);
    expect(texts.some((text) => text.includes('Вторая тема'))).toBe(true);
  });
});

describe('nothing is drawn off the paper', () => {
  it('keeps every string inside the margins, for a full and a degraded report', () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      row({
        at: { x: BigInt(index % 3), y: BigInt(index) },
        statement: { kind: 'SET', text: 'Расходы на региональные отделения и представительства' },
        organ: index % 2 === 0 ? { kind: 'UNRESOLVED', organ: UNLISTED } : { kind: 'UNREAD' },
      }),
    );
    const pages = compose({ rows, empty: false, degradedRows: 30, indexBehindBy: 5n });

    for (const page of pages) {
      for (const item of page.texts) {
        expect(item.x).toBeGreaterThanOrEqual(MARGIN);
        expect(item.y).toBeGreaterThanOrEqual(MARGIN);
        expect(item.y).toBeLessThanOrEqual(PAGE.height - MARGIN);
        expect(item.x + measure(item.text, item.size, item.bold)).toBeLessThanOrEqual(
          PAGE.width - MARGIN + 0.5,
        );
      }
      for (const rect of page.rects) {
        expect(rect.x).toBeGreaterThanOrEqual(MARGIN);
        expect(rect.x + rect.width).toBeLessThanOrEqual(PAGE.width - MARGIN + 0.5);
      }
    }
  });

  it('never lets a table row start without room for it', () => {
    // A row half off the bottom of a sheet loses the coordinate it carries.
    const rows = Array.from({ length: 300 }, (_, index) =>
      row({ at: { x: 3n, y: BigInt(index) } }),
    );
    const pages = compose({ rows, empty: false });

    for (const page of pages) {
      for (const item of page.texts) {
        expect(item.y).toBeGreaterThanOrEqual(MARGIN);
      }
    }
  });
});

describe('the column geometry', () => {
  it('fits both tables inside the content width', () => {
    expect(totalWidth(CELL_COLUMNS)).toBeLessThanOrEqual(CONTENT_WIDTH);
    expect(totalWidth(AXIS_COLUMNS)).toBeLessThanOrEqual(CONTENT_WIDTH);
  });

  it('starts every column at or after the margin and ends before the far one', () => {
    for (const columns of [CELL_COLUMNS, AXIS_COLUMNS]) {
      columnOffsets(columns).forEach((offset, index) => {
        expect(offset).toBeGreaterThanOrEqual(MARGIN);
        expect(offset + columns[index].width).toBeLessThanOrEqual(PAGE.width - MARGIN);
      });
    }
  });

  it('agrees with the wording checker about the narrowest column', () => {
    // The checker bounds every `reportColumn.*` slot by this number. If a column
    // narrows below it, a header that passed the checker starts overrunning.
    expect(NARROWEST_COLUMN).toBe(70);
    expect(
      Math.min(
        ...CELL_COLUMNS.map((column) => column.width),
        ...AXIS_COLUMNS.map((column) => column.width),
      ),
    ).toBe(NARROWEST_COLUMN);
  });
});

describe('truncation', () => {
  it('cuts to the measured width and marks the cut', () => {
    const long = 'Расходы на региональные отделения и представительства партии';
    const cut = fit(long, 7.5, false, 100, measure);

    expect(cut.endsWith('…')).toBe(true);
    expect(measure(cut, 7.5, false)).toBeLessThanOrEqual(100);
  });

  it('leaves text that already fits completely alone', () => {
    expect(fit('Бюджет', 7.5, false, 200, measure)).toBe('Бюджет');
  });

  it('returns nothing rather than an ellipsis alone in an impossible width', () => {
    expect(fit('Бюджет', 7.5, false, 0.1, measure)).toBe('');
  });
});

describe('an address in a table cell', () => {
  it('keeps both ends, because an author is recognised rather than transcribed', () => {
    // No form ever asks anyone to copy an author off this sheet, so the middle
    // is what an eye skips anyway.
    const short = shortenAddress(AUTHOR);

    expect(short.startsWith('0x57eb63')).toBe(true);
    expect(short).toContain('…');
    expect(short.length).toBeLessThan(AUTHOR.length);
  });
});
