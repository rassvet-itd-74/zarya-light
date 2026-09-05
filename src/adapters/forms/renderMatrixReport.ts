import fontkit from '@pdf-lib/fontkit';
import { type PDFFont, PDFDocument, rgb } from 'pdf-lib';
import type { MatrixReport } from '../../domain/matrix/matrixReport';
import type { MatrixReportWriter, RenderedReport } from '../../domain/ports/MatrixReportWriter';
import { type Measure, type Tone, composeMatrixReport } from './composeMatrixReport';
import { REPORT_TITLE, labelText } from './formLabels';
import type { TemplateAssets } from './issueTemplate';
import { PAGE } from './reportLayout';

/**
 * The matrix reference, drawn.
 *
 * Everything that could be decided has been, in `composeMatrixReport` — which
 * exists because with an embedded custom font `drawText` writes glyph
 * identifiers rather than characters, so a claim about what this document *says*
 * is unverifiable once it is a content stream. What is left here is mechanism:
 * embed, position, save.
 *
 * ## The font is embedded whole, and subsetting is what broke it
 *
 * This used to pass `{ subset: true }`, on the reasoning that a report has no
 * fields — nothing will ever regenerate an appearance from this font, so only
 * the glyphs actually drawn are needed. The reasoning is sound and the result was
 * not: pdf-lib's subset **dropped most of the Cyrillic**.
 *
 * Seen on 2026-09-05, on the first report a person ever produced from the button.
 * Rendered in a viewer, «Отчёт по состоянию Зари» came out as scattered letters
 * on a mostly blank page — `б в д ц ф ч ь П Э Т ю` survived and `а е и о н с т р
 * л к м п у я` did not. The same model with the font embedded whole renders every
 * sentence correctly, so the composition was never at fault.
 *
 * Subsetting was a **size optimization**, never a safety one, and it cost a
 * governance document its legibility. The forms already embed PT Sans whole at
 * ~327 KB for a different reason — a viewer regenerates a text field's appearance
 * from the font named in its `/DA` — and a report now costs the same ~326 KB. A
 * reference sheet a voter cannot read is worth nothing at any size.
 *
 * Not investigated: *why* the subset drops those glyphs. It is pdf-lib's
 * subsetter, the fix does not depend on the answer, and a governance document is
 * the wrong place to carry a workaround for a library defect.
 *
 * ## It is a report, not a form, and cannot become one
 *
 * No fields, no `zarya.meta.schemaVersion`, no `operationRef`, so it cannot
 * re-enter ingestion — and it needs no new guard, because the parser refuses
 * anything without a recognised schema version and a report fails that by having
 * no fields whatsoever. Pinned by a test rather than assumed.
 */

const TONES: { readonly [T in Tone]: ReturnType<typeof rgb> } = {
  ink: rgb(0.09, 0.09, 0.11),
  muted: rgb(0.42, 0.42, 0.46),
  /** A field that could **not** be read — visible without shouting. */
  warn: rgb(0.62, 0.22, 0.16),
};

const RULE = rgb(0.78, 0.78, 0.82);
const HEADER_BG = rgb(0.95, 0.95, 0.96);

export class MatrixReportRenderer implements MatrixReportWriter {
  constructor(private readonly assets: TemplateAssets) {}

  async render(report: MatrixReport): Promise<RenderedReport> {
    // `updateMetadata: false` for the reason issuance sets it: pdf-lib's
    // constructor otherwise stamps `ModDate` with `new Date()`, and a report
    // whose bytes depend on when it ran cannot be compared against a
    // regeneration of the same block.
    const document = await PDFDocument.create({ updateMetadata: false });
    document.registerFontkit(fontkit);

    // Whole, not subset. See the note above: the subset dropped most of the
    // party's alphabet and produced an unreadable page that every test passed.
    const regular = await document.embedFont(this.assets.fontRegular, { subset: false });
    const bold = await document.embedFont(this.assets.fontBold, { subset: false });
    const logo = await document.embedPng(this.assets.logoPng);

    document.setTitle(labelText(REPORT_TITLE));
    document.setProducer('zarya-light');
    document.setCreator('zarya-light');
    // Pinned to the epoch: this document's date is the **block** it was read at,
    // printed on every page. A creation timestamp would be a second, conflicting
    // answer to "how old is this".
    const epoch = new Date(0);
    document.setCreationDate(epoch);
    document.setModificationDate(epoch);

    const composed = composeMatrixReport(report, measurer(regular, bold));

    for (const composedPage of composed) {
      const page = document.addPage([PAGE.width, PAGE.height]);

      page.drawImage(logo, composedPage.logo);

      // Rectangles first, then rules, then text — a header band drawn after its
      // own labels would paint over them.
      for (const rect of composedPage.rects) {
        page.drawRectangle({ ...rect, color: HEADER_BG });
      }
      for (const rule of composedPage.rules) {
        page.drawLine({
          start: { x: rule.from, y: rule.y },
          end: { x: rule.to, y: rule.y },
          thickness: 0.75,
          color: RULE,
        });
      }
      for (const item of composedPage.texts) {
        page.drawText(item.text, {
          x: item.x,
          y: item.y,
          size: item.size,
          font: item.bold ? bold : regular,
          color: TONES[item.tone],
        });
      }
    }

    return { bytes: await document.save(), pageCount: composed.length };
  }
}

/**
 * The one thing composition cannot know: how wide a string is in PT Sans.
 *
 * Injected rather than imported so the layout can be tested with a measurer that
 * needs no font, and exported so a test can use the real one.
 */
export const measurer = (regular: PDFFont, bold: PDFFont): Measure => (text, size, isBold) =>
  (isBold ? bold : regular).widthOfTextAtSize(text, size);
