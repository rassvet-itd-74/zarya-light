import zlib from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from 'pdf-lib';

/**
 * The structural hazards a returned form may carry, separated from reading it.
 *
 * `pdfFormParser` answers "what does this form say". This answers "is this file
 * one we are willing to open at all", which is a different question with
 * different evidence, and keeping them apart stops the parser's field loop from
 * growing a second job.
 *
 * ## What each check is actually defending
 *
 * The application never executes anything in a PDF and reads nothing but field
 * names and values, so none of these can steer a governance decision. The reason
 * they are refused is narrower and worth stating, because it decides how strict
 * each one should be:
 *
 * - **A returned form is re-emitted.** Phase 6 stamps a receipt onto the file the
 *   member sent back and hands it out as the confirmed record. Anything hostile
 *   left in it would be re-published over this application's name.
 * - **A form that carries these was rebuilt.** No template this application
 *   issues has an attachment, a remote action, or a bomb in it. Their presence
 *   means the file is not the document that was handed out, whatever its fields
 *   happen to say.
 *
 * Both are about the *file*, not about the values — which is why these are
 * rejections rather than something the intent model would judge.
 *
 * ## What is deliberately not refused here
 *
 * **PDF JavaScript.** `/OpenAction` with `/JS` still parses, as it always has:
 * pdf-lib has no interpreter, the action is inert data to this application, and
 * `pdfFormParser`'s own tests pin that. The re-emission argument above applies to
 * it just as much as to an attachment, so this is an inconsistency rather than a
 * settled position — recorded in the worklog for the product owner rather than
 * changed here on my own judgement.
 */

/**
 * Per-stream inflate cap.
 *
 * Measured rather than picked: a 200 MB run of spaces compresses to 204 KB —
 * **1029×** — so the 4 MiB file cap alone permits roughly 4 GB of inflate. The
 * worker would fail to allocate that, the supervisor would restart it, and the
 * import would fail; not a compromise, but a denial of service a member could
 * trigger with one file.
 *
 * 16 MiB is two orders of magnitude above the largest legitimate stream this
 * application produces — an embedded PT Sans face is under 300 KB — and small
 * enough that the worst case is bounded well below where allocation fails.
 */
export const MAX_DECOMPRESSED_STREAM_BYTES = 16 * 1024 * 1024;

/**
 * How deep the hazard walk will follow a structure before refusing.
 *
 * This bound exists for **this module's own traversal**, which is the honest
 * reason: pdf-lib was probed at nesting depths of 100, 1 000, 10 000 and 100 000
 * and never overflowed a stack — at 10 000 it fails to parse the object and
 * throws, which the parser already reports as unreadable. So the library did not
 * need protecting from depth; a recursive walk added on top of it does.
 *
 * A real form nests four or five deep. 64 is far past any legitimate structure
 * and far short of a stack.
 */
export const MAX_OBJECT_DEPTH = 64;

export type HazardCode =
  /** An attachment. A governance form carries none, and a receipt must not re-emit one. */
  | 'EMBEDDED_FILE'
  /** An action that reaches outside the file — a URL, another document, a submit target. */
  | 'EXTERNAL_REFERENCE'
  /** A stream that inflates past what any legitimate form contains. */
  | 'COMPRESSION_BOMB'
  /** Structure nested past what this application will walk. */
  | 'TOO_DEEPLY_NESTED';

export interface Hazard {
  readonly code: HazardCode;
  /** One line, safe to show a user. Never echoes file content back. */
  readonly message: string;
}

/**
 * Actions that leave the document.
 *
 * `SubmitForm` is the one that matters most on a *form*: a viewer offering to
 * send a member's filled governance data to somebody else's server is the exact
 * shape of attack this document type invites. The rest are refused with it
 * because none of them belong in a template this application issued.
 */
const EXTERNAL_ACTIONS: ReadonlySet<string> = new Set([
  'URI',
  'GoToR',
  'GoToE',
  'Launch',
  'SubmitForm',
  'ImportData',
  'Movie',
  'Sound',
  'RichMediaExecute',
]);

/**
 * Scans the **raw bytes**, before the library sees them.
 *
 * It has to be before: pdf-lib inflates object streams during `load`, so a bound
 * applied to the loaded document would be applied after the allocation it is
 * meant to prevent. Content streams are lazy and never touched — measured — but
 * an object stream is not, and telling them apart requires parsing the very file
 * this is guarding against.
 *
 * So every Flate stream is inflated here under `maxOutputLength`, which makes
 * `zlib` itself enforce the bound and stop rather than finish and be measured.
 *
 * **Deliberately approximate, and safe in that direction.** It finds
 * `stream` … `endstream` spans by scanning, without resolving the object model —
 * a file whose bytes cannot be framed this way simply yields fewer candidates,
 * and every candidate that *is* found is bounded. The failure mode is a bomb
 * that gets through to pdf-lib, which is where the file cap still applies, never
 * a legitimate form refused for a structure this misread.
 *
 * Only `FlateDecode` is covered. `LZWDecode` can also expand, is not produced by
 * any modern writer, and would need its own decoder to bound — a gap, recorded
 * rather than papered over.
 */
export function findCompressionBomb(bytes: Uint8Array): Hazard | undefined {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let cursor = 0;
  for (;;) {
    const start = haystack.indexOf(STREAM_KEYWORD, cursor);
    if (start === -1) return undefined;

    const end = haystack.indexOf(ENDSTREAM_KEYWORD, start);
    if (end === -1) return undefined;

    // The dictionary immediately before the keyword says how the bytes are
    // encoded. Bounded lookbehind rather than a parse: a filter name further
    // back than this belongs to a different object.
    const preamble = haystack
      .subarray(Math.max(0, start - DICTIONARY_LOOKBEHIND), start)
      .toString('latin1');

    if (preamble.includes('/FlateDecode')) {
      const body = haystack.subarray(afterKeyword(haystack, start), end);
      if (inflatesPastBound(body)) {
        return {
          code: 'COMPRESSION_BOMB',
          message:
            'This file contains compressed data that expands far past anything a governance ' +
            'form holds. It was not opened.',
        };
      }
    }

    cursor = end + ENDSTREAM_KEYWORD.length;
  }
}

const STREAM_KEYWORD = Buffer.from('stream', 'latin1');
const ENDSTREAM_KEYWORD = Buffer.from('endstream', 'latin1');

/** Enough to carry a stream dictionary's filter entry, not enough to reach the previous object. */
const DICTIONARY_LOOKBEHIND = 2048;

/** The keyword is followed by CRLF or LF, and the data starts after it. */
const afterKeyword = (haystack: Buffer, start: number): number => {
  let at = start + STREAM_KEYWORD.length;
  if (haystack[at] === 0x0d) at += 1;
  if (haystack[at] === 0x0a) at += 1;
  return at;
};

const inflatesPastBound = (body: Buffer): boolean => {
  try {
    zlib.inflateSync(body, { maxOutputLength: MAX_DECOMPRESSED_STREAM_BYTES });
    return false;
  } catch (error) {
    // Two failures reach here and they mean opposite things. `ERR_BUFFER_TOO_LARGE`
    // is zlib stopping at the bound — the hazard. Anything else is data that is
    // not a Flate stream at all, which this scan is not entitled to judge:
    // `endstream` may have appeared inside binary content, and a misframed span
    // must not become a refusal.
    return isBoundExceeded(error);
  }
};

const isBoundExceeded = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';

/**
 * Walks the loaded document for attachments and outward references.
 *
 * Every indirect object is visited, rather than only the places the
 * specification says these belong: a `/Filespec` reachable from an annotation
 * this code did not think to look at is still a file the receipt would re-emit.
 * Enumeration is flat and cheap, and the depth bound covers what nests inside.
 */
export function findFileHazards(document: PDFDocument): Hazard | undefined {
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    const hazard = inspect(object, 0);
    if (hazard !== undefined) return hazard;
  }
  return undefined;
}

function inspect(value: unknown, depth: number): Hazard | undefined {
  if (depth > MAX_OBJECT_DEPTH) {
    return {
      code: 'TOO_DEEPLY_NESTED',
      message:
        'This file nests its structure deeper than a governance form ever does, so it was ' +
        'not read.',
    };
  }

  if (value instanceof PDFArray) {
    for (let index = 0; index < value.size(); index += 1) {
      const hazard = inspect(value.get(index), depth + 1);
      if (hazard !== undefined) return hazard;
    }
    return undefined;
  }

  // A stream's dictionary is walked; its bytes are not, and never are.
  const dict = value instanceof PDFStream ? value.dict : value;
  if (!(dict instanceof PDFDict)) return undefined;

  const named = declaredHazard(dict);
  if (named !== undefined) return named;

  for (const [, entry] of dict.entries()) {
    // References are followed by enumeration itself, so descending through one
    // here would revisit the whole graph per object and could not terminate on a
    // cycle.
    if (entry instanceof PDFRef) continue;
    const hazard = inspect(entry, depth + 1);
    if (hazard !== undefined) return hazard;
  }
  return undefined;
}

/** What this one dictionary declares itself to be, ignoring what it contains. */
function declaredHazard(dict: PDFDict): Hazard | undefined {
  const type = nameOf(dict.get(PDFName.of('Type')));
  const subtype = nameOf(dict.get(PDFName.of('Subtype')));

  // `/EF` is the embedded-file entry of a file specification, and `/Filespec` is
  // the specification itself. Either is an attachment; a `/Filespec` without
  // `/EF` points at a file outside this document, which is the other half of the
  // same problem.
  if (type === 'Filespec' || dict.get(PDFName.of('EF')) !== undefined) {
    return {
      code: 'EMBEDDED_FILE',
      message:
        'This form carries an attached or referenced file. Governance forms carry none, and ' +
        'this application will not re-issue one on a receipt.',
    };
  }
  if (subtype === 'FileAttachment') {
    return {
      code: 'EMBEDDED_FILE',
      message: 'This form carries a file attachment annotation. It cannot be imported.',
    };
  }
  // The catalog's name tree, which is where an attachment hides when nothing
  // points at it from a page.
  if (dict.get(PDFName.of('EmbeddedFiles')) !== undefined) {
    return {
      code: 'EMBEDDED_FILE',
      message: 'This form declares embedded files. It cannot be imported.',
    };
  }

  const action = nameOf(dict.get(PDFName.of('S')));
  if (action !== undefined && EXTERNAL_ACTIONS.has(action)) {
    return {
      code: 'EXTERNAL_REFERENCE',
      message:
        'This form contains an action that reaches outside the document — a link, another ' +
        'file, or a submission target. It cannot be imported.',
    };
  }

  return undefined;
}

const nameOf = (value: unknown): string | undefined =>
  value instanceof PDFName ? value.asString().replace(/^\//, '') : undefined;
