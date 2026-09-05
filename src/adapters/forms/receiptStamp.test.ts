import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { RECEIPT_LABELS, labelText } from './formLabels';
import {
  STAMP,
  STAMP_BAND_WIDTH,
  STAMP_HALF_BAND_WIDTH,
  stampStrokes,
} from './receiptStampArt';
import { MARGIN, PAGE } from './templateLayout';

/**
 * The stamp's geometry, checked against the things that can actually break it.
 *
 * Everything here is measured in the embedded font at the drawn size. The
 * alternative — trusting a comment about how wide 66 hexadecimal characters are
 * — is how this project shipped a matrix report nobody could read for three
 * days, and a transaction hash that runs off the edge of a stamp is the same
 * class of defect: the document looks finished and the one value a member could
 * check against a block explorer is unusable.
 */

const REGULAR = readFileSync('src/assets/pt-sans/PTSans-Regular.ttf');
const BOLD = readFileSync('src/assets/pt-sans/PTSans-Bold.ttf');
const SVG = readFileSync('src/assets/receipt-stamp.svg');

/** A real hash, a real address, and the widest instant this can render. */
const HASH = '0x97d6e0e4c14b7645cf4afc851c990d51092e69b611b11748703425e563bb6be4';
const SIGNER = '0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD';
const CONFIRMED_AT = '2026-09-06 14:16:48 UTC';

let widthOf: (text: string, face: 'regular' | 'bold', size: number) => number;

beforeAll(async () => {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const faces = {
    regular: await document.embedFont(REGULAR),
    bold: await document.embedFont(BOLD),
  };
  widthOf = (text, face, size) => faces[face].widthOfTextAtSize(text, size);
});

describe('the transaction hash, which sizes the stamp', () => {
  it('fits its band at the size it is drawn', () => {
    const width = widthOf(HASH, 'regular', STAMP.type.hash);
    expect(
      width,
      `${HASH.length} characters is ${Math.round(width)}pt at ${STAMP.type.hash}pt, over ${STAMP_BAND_WIDTH}pt`,
    ).toBeLessThanOrEqual(STAMP_BAND_WIDTH);
  });

  it('has room to spare, so a wider glyph set does not push it over', () => {
    // A hash is hexadecimal, so it draws from sixteen characters and the widest
    // possible one is all `f`. Measured rather than assumed to be equal to the
    // sample above.
    const widest = `0x${'f'.repeat(64)}`;
    expect(widthOf(widest, 'regular', STAMP.type.hash)).toBeLessThanOrEqual(STAMP_BAND_WIDTH);
  });

  it('is still transcribable at the size chosen, and would not be much below it', () => {
    // The number a person has to be able to read off paper. 8pt is roughly the
    // floor for a 66-character string of unspaced hexadecimal — below about 7pt
    // adjacent characters stop being separable at 300dpi, and this is the one
    // value on the document that has to be copied by hand.
    //
    // Recorded as an assertion so that shrinking the type to make something else
    // fit fails here rather than on paper.
    expect(STAMP.type.hash).toBeGreaterThanOrEqual(7.5);
  });
});

describe('every other fact fits where it is drawn', () => {
  it('fits the signer address in a full band', () => {
    expect(widthOf(SIGNER, 'regular', STAMP.type.value)).toBeLessThanOrEqual(STAMP_BAND_WIDTH);
  });

  it('fits the confirmation time in a half band', () => {
    expect(widthOf(CONFIRMED_AT, 'regular', STAMP.type.value)).toBeLessThanOrEqual(
      STAMP_HALF_BAND_WIDTH,
    );
  });

  it('fits every applied label in a half band', () => {
    // The labels are also checked by `formLabels.test.ts` against the same
    // width. Repeated here because that test measures whatever wording is
    // currently applied and this one names the geometry it belongs to.
    for (const [key, label] of Object.entries(RECEIPT_LABELS)) {
      const width = widthOf(labelText(label), 'bold', STAMP.type.label);
      expect(width, `${key} is ${Math.round(width)}pt`).toBeLessThanOrEqual(STAMP_HALF_BAND_WIDTH);
    }
  });
});

describe('the asset and the geometry agree', () => {
  it('rules the bands at exactly the heights the text is placed from', () => {
    // The failure this prevents: a rule moved in the SVG while the offsets stay
    // here, so labels sit across their own lines. Both look right in isolation
    // and the only way to see it is to print one.
    // Full matches only: the frame and the corner ticks also begin `M x y H`,
    // and a band rule is a path that is nothing but one horizontal run.
    const horizontal = stampStrokes(SVG)
      .map((stroke) => /^M [\d.]+ ([\d.]+) H [\d.]+$/.exec(stroke.d))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));

    const expected = [
      STAMP.bands.title.bottom,
      STAMP.bands.hash.bottom,
      STAMP.bands.upper.bottom,
      STAMP.bands.lower.bottom,
      STAMP.bands.signer.bottom,
    ];
    expect(horizontal).toEqual(expected);
  });

  it('splits the paired bands where the right column starts', () => {
    const split = stampStrokes(SVG).find((stroke) => /^M [\d.]+ [\d.]+ V [\d.]+$/.test(stroke.d));
    expect(split?.d).toBe(
      `M ${STAMP.columns.split} ${STAMP.bands.upper.top} V ${STAMP.bands.lower.bottom}`,
    );
    expect(STAMP.columns.right).toBeGreaterThan(STAMP.columns.split);
  });

  it('is paths only, and says so rather than dropping what it cannot draw', () => {
    // `drawSvgPath` understands nothing else, so a `<rect>` someone adds would
    // vanish from the stamp with no error at all.
    const withRect = Buffer.from(
      new TextDecoder().decode(SVG).replace('</svg>', '<rect x="0" y="0"/></svg>'),
    );
    expect(() => stampStrokes(withRect)).toThrow(/rect/);
    expect(() => stampStrokes(Buffer.from('<svg></svg>'))).toThrow(/no paths/);
  });

  it('ignores comments, which is where the asset explains itself', () => {
    // The asset opens with a long comment. A naive scan would find `<path` in
    // prose describing paths.
    // Two frame rules, four corner ticks, the star, five band rules, one split.
    expect(stampStrokes(SVG)).toHaveLength(13);
  });
});

describe('where the stamp lands', () => {
  it('sits inside the printable area of an A4 page', () => {
    // It overprints the form, so nothing reserves room for it — but landing off
    // the paper would be a different thing entirely, and some printers clip the
    // margin.
    const originX = PAGE.width - MARGIN - STAMP.width;
    expect(originX).toBeGreaterThanOrEqual(MARGIN);
    expect(MARGIN + STAMP.height).toBeLessThanOrEqual(PAGE.height - MARGIN);
  });
});
