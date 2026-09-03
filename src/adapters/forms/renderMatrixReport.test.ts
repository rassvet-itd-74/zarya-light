import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { MatrixKind } from '../../domain/matrix/matrix';
import type { AxisInventory, MatrixReport, ReportRow } from '../../domain/matrix/matrixReport';
import { bytes32, evmAddress, unixSeconds } from '../../domain/primitives';
import { drawnCharacters } from './formLabels';
import type { TemplateAssets } from './issueTemplate';
import { parseFormFields } from './pdfFormParser';
import { MatrixReportRenderer } from './renderMatrixReport';
import { PAGE } from './reportLayout';

/**
 * The mechanism: real font, real logo, real bytes.
 *
 * What the document *says* is asserted in `composeMatrixReport.test.ts`, because
 * a subset embedded font writes glyph identifiers and a content stream cannot be
 * read back as text. What is left to prove here is what only a real PDF can
 * show: that it has no fields, that this application's own ingestion refuses it,
 * that PT Sans encodes the party's Cyrillic without throwing, and that
 * subsetting actually produces a small file.
 */

const ASSETS: TemplateAssets = {
  fontRegular: readFileSync('src/assets/pt-sans/PTSans-Regular.ttf'),
  fontBold: readFileSync('src/assets/pt-sans/PTSans-Bold.ttf'),
  logoPng: readFileSync('src/assets/logo.png'),
};

const renderer = new MatrixReportRenderer(ASSETS);

const ORGAN = bytes32(`0x${'11'.repeat(32)}`);
const AUTHOR = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');
const READ_AT = { blockNumber: 8_642_197n, timestamp: unixSeconds(1_756_312_800) };

const emptyAxes = (): { [K in MatrixKind]: AxisInventory } => ({
  CATEGORICAL: { themes: [], statements: [] },
  NUMERICAL: { themes: [], statements: [] },
});

const row = (overrides: Partial<ReportRow> = {}): ReportRow => ({
  matrix: 'CATEGORICAL',
  at: { x: 3n, y: 7n },
  theme: { kind: 'SET', text: 'Бюджет партии' },
  statement: { kind: 'SET', text: 'Расходы на региональные отделения' },
  organ: { kind: 'LABELLED', organ: ORGAN, label: '74.СОВ' },
  binding: { kind: 'BOUND', organ: ORGAN },
  categories: [{ category: 1n, name: { kind: 'SET', text: 'ЗА' } }],
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

describe('a report is not a form and cannot become one', () => {
  it('carries no AcroForm fields at all', async () => {
    const rendered = await renderer.render(report({ rows: [row()], empty: false }));
    const document = await PDFDocument.load(rendered.bytes);

    expect(document.getForm().getFields()).toEqual([]);
  });

  it('is refused by this application’s own ingestion', async () => {
    // The guard is the parser's existing schema-version check rather than a new
    // one: a report has no fields, so it fails that check by construction. The
    // property is pinned rather than assumed, because "it cannot be submitted"
    // is the whole reason a report may carry chain data at all.
    const rendered = await renderer.render(report({ rows: [row()], empty: false }));

    const parsed = await parseFormFields(rendered.bytes);
    expect(parsed.kind).not.toBe('FIELDS');
  });
});

describe('the page', () => {
  it('is landscape A4, every sheet', async () => {
    // A statement is a sentence and the table has eight columns; portrait would
    // truncate the field that tells a voter what a row means.
    const rows = Array.from({ length: 200 }, (_, index) =>
      row({ at: { x: BigInt(index % 5), y: BigInt(index) } }),
    );
    const rendered = await renderer.render(report({ rows, empty: false }));
    const document = await PDFDocument.load(rendered.bytes);

    expect(rendered.pageCount).toBeGreaterThan(1);
    expect(document.getPageCount()).toBe(rendered.pageCount);
    for (const page of document.getPages()) {
      expect(page.getSize()).toEqual({ width: PAGE.width, height: PAGE.height });
    }
    expect(PAGE.width).toBeGreaterThan(PAGE.height);
  });

  it('is a single real sheet for an empty matrix', async () => {
    const rendered = await renderer.render(report());

    expect(rendered.pageCount).toBe(1);
    expect(rendered.bytes.byteLength).toBeGreaterThan(0);
  });
});

describe('Cyrillic that comes from the chain, not from the label table', () => {
  it('draws a theme, a statement and a category name without an encoding failure', async () => {
    // These are the party's own words, read from the contract. The embedded font
    // has to cover whatever the party wrote, not merely what this codebase says.
    await expect(
      renderer.render(
        report({
          rows: [row()],
          empty: false,
          axes: {
            ...emptyAxes(),
            CATEGORICAL: {
              themes: [{ coordinate: 3n, text: 'Бюджет партии', confirmation: { kind: 'MATCHES' } }],
              statements: [
                {
                  coordinate: 7n,
                  text: 'Расходы на региональные отделения',
                  confirmation: { kind: 'DIFFERS', onChain: 'Расходы на аппарат' },
                },
              ],
            },
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('draws the whole Russian alphabet in both cases, «ё» included', async () => {
    const alphabet = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';

    await expect(
      renderer.render(
        report({
          rows: [row({ theme: { kind: 'SET', text: alphabet } })],
          empty: false,
          axes: {
            ...emptyAxes(),
            CATEGORICAL: {
              themes: [{ coordinate: 3n, text: alphabet, confirmation: { kind: 'MATCHES' } }],
              statements: [],
            },
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('draws the em dash and the ellipsis, which are literals rather than label slots', async () => {
    // `—` for a field with nothing to hold and `…` for a truncation. Neither is
    // in `SLOT_ENGLISH`, so the font-coverage check over the label table does
    // not reach them — and a glyph PT Sans lacked would throw at render time,
    // which for a document generated on demand means at the moment of use.
    const long = 'Расходы на региональные отделения и представительства партии в регионах и округах';

    await expect(
      renderer.render(
        report({
          rows: [
            // No value: the author and timestamp columns fall back to the dash.
            row({ value: { kind: 'NONE' }, statement: { kind: 'SET', text: long } }),
          ],
          empty: false,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('draws every label slot this application has, pending ones included', async () => {
    // The same guard the templates have: a slot the font cannot encode is a
    // throw at render time, and a report is generated on demand rather than at
    // build time, so nothing else would catch it first.
    await expect(
      renderer.render(
        report({
          rows: [row({ theme: { kind: 'SET', text: drawnCharacters().slice(0, 400) } })],
          empty: false,
        }),
      ),
    ).resolves.toBeDefined();
  });
});

describe('the font is subset here, unlike on a form', () => {
  it('produces a document far smaller than a whole-font template', async () => {
    // A form embeds PT Sans whole at ~327 KB because a viewer regenerates a
    // field's appearance from it. A report has no fields, so nothing will ever
    // regenerate anything and only the drawn glyphs are needed.
    const rendered = await renderer.render(report({ rows: [row()], empty: false }));

    expect(rendered.bytes.byteLength).toBeLessThan(120_000);
  });
});

describe('two renderings of one block', () => {
  it('are byte-identical, so a report is reproducible rather than timestamped', async () => {
    // Nothing in the document may depend on when it ran: its date is the block
    // it was read at, which is printed on every page.
    const input = report({ rows: [row()], empty: false });
    const first = await renderer.render(input);
    const second = await renderer.render(input);

    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
  });
});
