import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import type {
  ReceiptFacts,
  ReceiptStamper,
  StampedReceipt,
} from '../../domain/ports/ReceiptStamper';
import { META_FIELDS, RECEIPT_FIELDS } from './formSchema';
import { BRAND, RECEIPT_LABELS, STAMP_NOTICE, STAMP_TITLE, labelText } from './formLabels';
import { STAMP, stampStrokes } from './receiptStampArt';
import { MARGIN, PAGE } from './templateLayout';

/**
 * `ReceiptStamper` over pdf-lib: a stamp applied to the page, not fields filled
 * in.
 *
 * ## It overprints, and that is the point
 *
 * The stamp is put on top of the returned document the way a rubber stamp is put
 * on paper. Nothing is reserved for it at issuance, the template is not laid out
 * around it, and no page is added — so it lands on whatever is in the bottom
 * right corner of the last page.
 *
 * That costs something, and the cost is paid deliberately: the stamp's interior
 * is an **opaque ground**, so whatever it covers is covered. Six facts drawn
 * straight onto a member's own text would leave neither readable, and a receipt
 * whose transaction hash cannot be transcribed is not a receipt. The frame and
 * its corner ticks still sit directly on page content, which is what makes it
 * read as applied rather than as part of the form.
 *
 * ## Order: flatten, then stamp
 *
 * Flattening bakes each field's appearance into the page's content stream, and
 * pdf-lib appends that content — so a stamp drawn *before* flattening would end
 * up underneath the very values it is stamping. Flattening first makes the stamp
 * the last ink on the page, which is also what "applied on top" has to mean.
 *
 * Flattening is still what stops a receipt being refilled and resubmitted, and
 * ingestion's flattened-form check catches it independently. Two mechanisms,
 * neither relying on the other.
 *
 * ## No fields are written at all
 *
 * There is nothing to overwrite: `zarya.receipt.*` are no longer fields, so a
 * member cannot type a plausible transaction hash into one to begin with. The
 * old rule — overwrite unconditionally, never merge — is now structural rather
 * than a discipline the stamper has to keep.
 *
 * The font is embedded **whole**, as everywhere else in this client: a subset
 * dropped most of the Cyrillic on the matrix report (`DECISIONS.md`).
 */

export interface ReceiptAssets {
  readonly fontRegular: Uint8Array;
  readonly fontBold: Uint8Array;
  /**
   * `src/assets/receipt-stamp.svg`, as bytes.
   *
   * Injected rather than imported, for the reason the fonts are: Vite's
   * `?inline` resolves to a data URL in a build and to a path string under
   * vitest, so a module that imported its own asset would be untestable against
   * the real file.
   */
  readonly stampSvg: Uint8Array;
}

const BLUE = rgb(0x12 / 255, 0x37 / 255, 0x7e / 255);
const GROUND = rgb(1, 1, 1);

export class PdfReceiptStamper implements ReceiptStamper {
  constructor(private readonly assets: ReceiptAssets) {}

  async stamp(form: Uint8Array, facts: ReceiptFacts): Promise<StampedReceipt> {
    // `updateMetadata: false` for the reason issuance sets it: pdf-lib would
    // otherwise stamp `ModDate` with `new Date()`, and a receipt regenerated
    // from the same record must come out identical.
    const document = await PDFDocument.load(form, { updateMetadata: false });
    document.registerFontkit(fontkit);
    const regular = await document.embedFont(this.assets.fontRegular, { subset: false });
    const bold = await document.embedFont(this.assets.fontBold, { subset: false });

    // A document that cannot name its own operation was not issued here, and
    // stamping it would produce a plausible-looking file with nothing behind it.
    // Checked before flattening, because flattening destroys the evidence.
    const acroForm = document.getForm();
    for (const required of [META_FIELDS.schemaVersion, META_FIELDS.operationRef]) {
      acroForm.getTextField(required);
    }
    acroForm.flatten();

    const pages = document.getPages();
    const page = pages[pages.length - 1];
    const originX = PAGE.width - MARGIN - STAMP.width;
    const originY = MARGIN + STAMP.height;

    // SVG space — y down from the stamp's top-left — into page space.
    const at = (x: number, y: number) => ({ x: originX + x, y: originY - y });

    const { inset } = STAMP.ground;
    page.drawRectangle({
      ...at(inset, STAMP.height - inset),
      width: STAMP.width - inset * 2,
      height: STAMP.height - inset * 2,
      color: GROUND,
    });

    for (const stroke of stampStrokes(this.assets.stampSvg)) {
      page.drawSvgPath(stroke.d, {
        x: originX,
        y: originY,
        borderColor: BLUE,
        borderWidth: stroke.width,
      });
    }

    const write = (
      text: string,
      x: number,
      y: number,
      size: number,
      face = regular,
    ): void => {
      page.drawText(text, { ...at(x, y), size, font: face, color: BLUE });
    };

    const { bands, columns, type, offsets } = STAMP;

    write(labelText(BRAND), 40, 26, type.title, bold);
    write(labelText(STAMP_TITLE), 94, 25, type.subtitle);

    write(labelText(RECEIPT_LABELS.txHash), columns.left, bands.hash.top + 13, type.label, bold);
    write(facts.txHash, columns.left, bands.hash.top + 29, type.hash);

    const cell = (label: string, value: string, x: number, top: number): void => {
      write(label, x, top + offsets.label, type.label, bold);
      write(value, x, top + offsets.value, type.value);
    };

    cell(labelText(RECEIPT_LABELS.status), facts.status, columns.left, bands.upper.top);
    cell(
      labelText(RECEIPT_LABELS.blockNumber),
      facts.blockNumber,
      columns.right,
      bands.upper.top,
    );
    cell(labelText(RECEIPT_LABELS.chainId), String(facts.chainId), columns.left, bands.lower.top);
    cell(
      labelText(RECEIPT_LABELS.confirmedAt),
      // Chain block time as an ISO instant. Never the workstation clock.
      new Date(facts.confirmedAt * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC'),
      columns.right,
      bands.lower.top,
    );
    cell(labelText(RECEIPT_LABELS.signer), facts.signer, columns.left, bands.signer.top);

    write(labelText(STAMP_NOTICE), columns.left, bands.footer.top + 12, type.notice);

    return { bytes: await document.save(), drawnFacts: Object.values(RECEIPT_FIELDS) };
  }
}
