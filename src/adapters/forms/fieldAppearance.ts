import { PDFStream, decodePDFRawStream, PDFRawStream, type PDFTextField } from 'pdf-lib';

/**
 * What a field's rendered appearance says, when that can be established.
 *
 * A PDF text field carries its value twice: in `/V`, which is data, and in an
 * appearance stream, which is what a person actually sees. A viewer is entitled
 * to trust either. This application builds transactions from `/V` — that
 * decision is `pdfFormParser`'s and does not change — so a file where the two
 * disagree is one where **the member saw something other than what would be
 * submitted**.
 *
 * That is a tamper signal and it is reported rather than resolved. It is not a
 * refusal: the values that matter for authorization are recovered from the local
 * record regardless (hard rule 4), and a member whose viewer simply failed to
 * regenerate an appearance has done nothing wrong. Phase 9's review screen is
 * where a person decides.
 *
 * ## Why this answers `undefined` so often, and why that is correct
 *
 * Reading text back out of a content stream is only possible when the stream
 * encodes characters. An appearance drawn with an embedded font — which is every
 * appearance an issued Zarya template produces, because the labels are Cyrillic —
 * encodes **glyph identifiers**, and those cannot be turned back into text
 * without the font's own mapping.
 *
 * So the comparison is deliberately restricted to appearances that come back as
 * printable ASCII, with an ASCII `/V` to compare against. That covers exactly the
 * fields where a substitution would be worth making — an address, a voting
 * number, a coordinate, an amount — and skips the free Russian text where a
 * confident answer is not available. **Silence here means "not established",
 * never "they agree"**, and no caller may read it as the latter.
 */

/** The longest appearance this will read back. Beyond it, no answer is offered. */
const MAX_APPEARANCE_BYTES = 64 * 1024;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * The text of a field's normal appearance, or `undefined` when it cannot be
 * established.
 */
export function appearanceTextOf(field: PDFTextField): string | undefined {
  let stream: PDFStream | undefined;
  try {
    for (const widget of field.acroField.getWidgets()) {
      const normal = widget.getAppearances()?.normal;
      if (normal instanceof PDFStream) {
        // More than one widget means one field drawn in several places. They
        // should agree, and a disagreement between them is not this function's
        // question, so the first is used.
        stream = normal;
        break;
      }
    }
  } catch {
    // A widget whose appearance dictionary cannot be walked. Not established.
    return undefined;
  }
  if (stream === undefined) return undefined;

  let content: string;
  try {
    const bytes =
      stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
    if (bytes.length > MAX_APPEARANCE_BYTES) return undefined;
    content = Buffer.from(bytes).toString('latin1');
  } catch {
    return undefined;
  }

  const shown = showText(content);
  if (shown === undefined) return undefined;
  return PRINTABLE_ASCII.test(shown) ? shown : undefined;
}

/**
 * The strings handed to a text-showing operator, concatenated.
 *
 * Both string forms are read — `(literal)` and `<48657820>` — which is a
 * correction rather than a preference. The first version of this skipped hex on
 * the reasoning that hex is what a glyph-identifier encoding looks like, and
 * that was too broad: pdf-lib writes **every** appearance string as hex,
 * including the plain WinAnsi bytes a standard font produces, so skipping it
 * meant never establishing anything about any field. Probed, after the check
 * reported nothing on a fixture built to disagree.
 *
 * What actually separates a readable appearance from a glyph-encoded one is the
 * caller's printable-ASCII test, not the string syntax: glyph identifiers are
 * small integers written as two-byte codes, so they decode to control bytes and
 * are refused there.
 */
function showText(content: string): string | undefined {
  const parts: string[] = [];
  let found = false;

  for (const match of content.matchAll(SHOW_TEXT)) {
    found = true;
    for (const token of match[0].matchAll(STRING_TOKEN)) {
      parts.push(decodeString(token[0]));
    }
  }

  return found ? parts.join('') : undefined;
}

/** A string or an array of them, handed to `Tj` or `TJ`. */
const SHOW_TEXT = /(?:\((?:\\.|[^\\()])*\)|<[\dA-Fa-f\s]*>)\s*Tj|\[[^\][]*\]\s*TJ/g;

/** One string operand, in either syntax. */
const STRING_TOKEN = /\((?:\\.|[^\\()])*\)|<[\dA-Fa-f\s]*>/g;

const decodeString = (token: string): string =>
  token.startsWith('<')
    ? Buffer.from(token.slice(1, -1).replace(/\s+/g, ''), 'hex').toString('latin1')
    : unescape(token.slice(1, -1));

const unescape = (text: string): string =>
  text.replace(/\\([nrtbf()\\])/g, (_whole, character: string) => {
    switch (character) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      default:
        return character;
    }
  });
