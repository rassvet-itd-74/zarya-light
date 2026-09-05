import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

/**
 * Finding out whether a string was **drawn on the page**, for tests.
 *
 * There is no reading text back out of a PDF as text. pdf-lib writes an embedded
 * font's `Tj` operands as glyph identifiers, not as characters — the same thing
 * that made the appearance extractor need a printable-ASCII discriminator — so
 * the search happens in glyph space: lay the string out in the very font that
 * was embedded, and look for that run of ids in the content streams.
 *
 * Precise rather than approximate. A wrong string produces a different run, and
 * a string that was never drawn produces no match at all. This matters more than
 * it used to: since the context block and the receipt became drawn text, a value
 * that silently stopped being rendered would leave no field behind to miss it.
 */

/** Every decodable stream in the file, as latin1, lowercased. */
export async function drawnContent(bytes: Uint8Array): Promise<string> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  let streams = '';
  // Every stream rather than each page's `/Contents`: a page's contents can be
  // one stream or an array of them, and pdf-lib appends rather than replaces.
  // Decoding all of them cannot miss one, and a glyph run written as ASCII hex
  // does not occur by chance inside a font's binary.
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    try {
      streams += Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
    } catch {
      // Not a decodable stream. Nothing drawn lives in one.
    }
  }
  return streams.toLowerCase();
}

/** The glyph ids `text` lays out to in `file`, as the hex pdf-lib writes. */
export function asGlyphs(text: string, file: Uint8Array): string {
  const font = fontkit.create(Buffer.from(file)) as {
    layout(text: string): { glyphs: { id: number }[] };
  };
  return font
    .layout(text)
    .glyphs.map((glyph) => glyph.id.toString(16).padStart(4, '0'))
    .join('')
    .toLowerCase();
}
