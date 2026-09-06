import { PDFBool, PDFDict, PDFDocument, PDFName, PDFRadioGroup, PDFTextField } from 'pdf-lib';
import type { ParsedFormFields } from './assembleFormInput';
import { appearanceTextOf } from './fieldAppearance';
import { type HazardCode, findCompressionBomb, findFileHazards } from './pdfHazards';

/**
 * PDF bytes to field values, or a structural rejection. The only module that
 * touches a PDF library.
 *
 * It **never throws** — every failure is a rejection value — never runs or
 * fetches anything, and produces only field names and values, so nothing
 * downstream can be steered by page content or an action.
 *
 * Vocabulary is not its business: it reports names the schema does not define,
 * because `assembleFormInput` can only refuse what it is shown.
 *
 * Two pdf-lib behaviours it cannot prevent (`DECISIONS.md` has the evidence):
 * a corrupted `startxref` still loads by scanning, and a multi-megabyte field
 * value blows the stack during `load`. The first is tolerable because a
 * recovered document is judged by the same rules as any other; the second is
 * caught here, and {@link MAX_FILE_BYTES} exists for it.
 */

/**
 * The byte cap, applied **before** the library sees the file.
 *
 * A twelve-field form is under a kilobyte. An issued template carrying the logo
 * and an embedded Cyrillic font will be a few hundred, so 4 MiB is three orders
 * of magnitude of headroom — and it bounds both the inflate surface of a
 * compression bomb and the stack-recursion limit described above.
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** A Zarya form has under twenty fields. Anything near this is not one. */
export const MAX_FIELDS = 64;

/**
 * Per-value cap, in UTF-16 code units.
 *
 * Generous against the domain's own limits — 400 characters for a statement, 42
 * for an address — because this is a structural bound and the meaningful one is
 * `TEXT_LIMITS`, applied per field with a message a member can act on.
 */
export const MAX_FIELD_VALUE_LENGTH = 4096;

export type FormRejectionCode =
  /** Zero bytes. Not a file the dialog should have produced. */
  | 'EMPTY'
  | 'TOO_LARGE'
  /** Malformed, truncated, not a PDF, or defeated the parser. */
  | 'UNREADABLE'
  | 'ENCRYPTED'
  | 'XFA_PRESENT'
  /** No AcroForm dictionary: not a form at all — the matrix report lands here. */
  | 'NOT_A_FORM'
  /** An AcroForm with no fields, which is what flattening leaves behind. */
  | 'FLATTENED'
  | 'DUPLICATE_FIELD_NAME'
  | 'TOO_MANY_FIELDS'
  | 'FIELD_VALUE_TOO_LONG'
  | 'UNSUPPORTED_FIELD_TYPE'
  /** Attachments, outward references, bombs, and nesting. See `pdfHazards.ts`. */
  | HazardCode;

export interface FormRejection {
  readonly code: FormRejectionCode;
  readonly field?: string;
  /** One line, safe to show a user. Never echoes file content back. */
  readonly message: string;
}

/**
 * Something a person should be told about a form that was nonetheless read.
 *
 * Kept apart from a rejection because the two ask different things of a caller:
 * a rejection means there is nothing to import, and a disclosure means here is
 * what was imported **and** here is what looks wrong with it. Collapsing them
 * would either block a member whose viewer merely failed to redraw a field, or
 * silently submit a value they never saw.
 */
export type FormDisclosureCode = 'APPEARANCE_DISAGREES';

export interface FormDisclosure {
  readonly code: FormDisclosureCode;
  readonly field: string;
  readonly message: string;
}

export type FormParseResult =
  | {
      readonly kind: 'FIELDS';
      readonly fields: ParsedFormFields;
      /**
       * Empty on a form with nothing to remark on, which is the normal case.
       * Never a reason to withhold `fields` — see {@link FormDisclosure}.
       */
      readonly disclosures: readonly FormDisclosure[];
    }
  | { readonly kind: 'REJECTED'; readonly rejections: readonly FormRejection[] };

const rejected = (code: FormRejectionCode, message: string, field?: string): FormParseResult => ({
  kind: 'REJECTED',
  rejections: [{ code, message, ...(field === undefined ? {} : { field }) }],
});

/**
 * Reads a returned form.
 *
 * `async` because the library is, not because anything here waits on I/O — the
 * bytes arrive already read, so a parse cannot fail for a reason outside the
 * file.
 */
export async function parseFormFields(bytes: Uint8Array): Promise<FormParseResult> {
  if (bytes.length === 0) {
    return rejected('EMPTY', 'This file is empty.');
  }
  if (bytes.length > MAX_FILE_BYTES) {
    // Before the library, so an oversized file is never parsed at all.
    return rejected(
      'TOO_LARGE',
      `This file is larger than the ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB a governance form can be.`,
    );
  }

  // Also before the library, and for a sharper reason than the cap above:
  // pdf-lib inflates object streams during `load`, so a bound checked afterwards
  // would be checked after the allocation it exists to prevent. Measured, not
  // assumed — see `pdfHazards.ts`.
  const bomb = findCompressionBomb(bytes);
  if (bomb !== undefined) return rejected(bomb.code, bomb.message);

  let document: PDFDocument;
  try {
    // `ignoreEncryption` and then an explicit check, rather than catching the
    // encryption error: pdf-lib's `EncryptedPDFError` does not survive its own
    // CJS build — `instanceof` is false and `error.name` is `'Error'` — so the
    // alternative is matching an error message, which a patch release can
    // reword. Nothing is read from the document between the load and the check.
    document = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (error) {
    return rejected(
      'UNREADABLE',
      `This file could not be read as a PDF: ${
        error instanceof Error ? error.message.slice(0, 200) : 'unknown error'
      }`,
    );
  }

  if (document.isEncrypted) {
    return rejected(
      'ENCRYPTED',
      'This form is encrypted or password-protected. Remove the protection and import it again.',
    );
  }

  try {
    return readFields(document);
  } catch (error) {
    // The library reached a structure it could not walk. A rejection rather
    // than an exception, so the caller has one shape of answer to handle.
    return rejected(
      'UNREADABLE',
      `This form's field structure could not be read: ${
        error instanceof Error ? error.message.slice(0, 200) : 'unknown error'
      }`,
    );
  }
}

const isTrue = (value: unknown): boolean =>
  value instanceof PDFBool ? value.asBoolean() : false;

function readFields(document: PDFDocument): FormParseResult {
  // Checked on the catalog **before** `getForm()`, which creates an AcroForm
  // dictionary when none is present — asking it first would make every PDF look
  // like an empty form.
  const acroFormRef = document.catalog.get(PDFName.of('AcroForm'));
  if (acroFormRef === undefined) {
    return rejected(
      'NOT_A_FORM',
      'This PDF contains no form fields, so it is not a governance form. The matrix reference report is not a form and cannot be imported.',
    );
  }

  const acroForm = document.catalog.lookup(PDFName.of('AcroForm'));
  if (acroForm instanceof PDFDict && acroForm.get(PDFName.of('XFA')) !== undefined) {
    // XFA data can shadow the AcroForm values, so two readers disagree about
    // what the form says. Rejected rather than picking a winner.
    return rejected(
      'XFA_PRESENT',
      'This PDF carries XFA form data, which can disagree with the fields this application reads. It cannot be imported.',
    );
  }

  // Before any field is read: an attachment or an outward-reaching action makes
  // this a file we decline to open at all, whatever its fields say. A returned
  // form is re-emitted as a receipt in Phase 6, so anything left in it would go
  // back out over this application's name.
  const fileHazard = findFileHazards(document);
  if (fileHazard !== undefined) return rejected(fileHazard.code, fileHazard.message);

  // `/NeedAppearances` is the document declaring its own appearances stale and
  // asking the viewer to redraw them. When it is set, what a field currently
  // draws says nothing about what anyone saw, so there is nothing to compare
  // and the comparison is skipped rather than reported as a disagreement.
  const comparableAppearances = !isTrue(
    acroForm instanceof PDFDict ? acroForm.get(PDFName.of('NeedAppearances')) : undefined,
  );

  const fields = document.getForm().getFields();

  if (fields.length === 0) {
    // An AcroForm with no fields is what flattening leaves behind. Saying so
    // beats reporting an empty form and blaming the member for a blank field.
    return rejected(
      'FLATTENED',
      'This form has been flattened or printed and rescanned, so its field data is gone. Fill in a fresh template electronically.',
    );
  }
  if (fields.length > MAX_FIELDS) {
    return rejected(
      'TOO_MANY_FIELDS',
      `This form declares ${fields.length} fields; a governance form has at most ${MAX_FIELDS}.`,
    );
  }

  const rejections: FormRejection[] = [];
  const disclosures: FormDisclosure[] = [];
  const values: Record<string, string> = {};
  const seen = new Set<string>();

  for (const field of fields) {
    const name = field.getName();

    if (seen.has(name)) {
      // Two fields with one name are readable — pdf-lib returns both and its
      // `getTextField` hands back the first — and which one a viewer displays
      // is not determinable from the file. So neither is used.
      rejections.push({
        code: 'DUPLICATE_FIELD_NAME',
        field: name,
        message:
          'This form declares the same field twice. Which value a reader sees is not determinable, so neither is used.',
      });
      continue;
    }
    seen.add(name);

    // A present-but-unfilled field reads `undefined` from the library and must
    // become the empty string here. That distinction is load-bearing: absent
    // means the field is gone and the form is damaged, blank means a person did
    // not fill it in, and `assembleFormInput` answers the two differently.
    let value: string;
    if (field instanceof PDFTextField) {
      value = field.getText() ?? '';

      // `/V` stays authoritative — a transaction is built from data, not from a
      // rendering. What changes here is that a divergence is no longer silent:
      // it means the member saw one thing and another would be submitted.
      // `undefined` is "could not be established", never "they agree".
      //
      // An **empty** appearance is in that same "not established" category, and
      // saying so is what keeps this signal worth reading. A viewer that sets a
      // value without redrawing leaves exactly that shape, and it is the common
      // case rather than an exotic one: pdf-lib produces it, and it does not set
      // `/NeedAppearances` when it does. Reporting it would put a tamper warning
      // on every filled field of every legitimate import, which is how a warning
      // stops being read at all.
      //
      // A substitution looks different. It shows one real value where another is
      // stored, and both sides are non-empty — which is still caught.
      const drawn = comparableAppearances ? appearanceTextOf(field) : undefined;
      if (drawn !== undefined && drawn.trim().length > 0 && drawn !== value) {
        disclosures.push({
          code: 'APPEARANCE_DISAGREES',
          field: name,
          message:
            'What this field displays does not match the value stored in it. The stored value ' +
            'is the one this application reads, so check it before submitting.',
        });
      }
    } else if (field instanceof PDFRadioGroup) {
      // The export value, never a rendered label. Vote direction comes from
      // this and is never inferred from free text.
      value = field.getSelected() ?? '';
    } else {
      // Checkboxes, dropdowns, option lists, buttons and signature fields. No
      // Zarya template contains one, so a field of this type carrying a schema
      // name is a file that was rebuilt — and reading its value would mean
      // deciding what a checkbox means as governance text.
      rejections.push({
        code: 'UNSUPPORTED_FIELD_TYPE',
        field: name,
        message:
          'This form contains a field of a kind governance forms do not use. Only text fields and option groups are read.',
      });
      continue;
    }

    if (value.length > MAX_FIELD_VALUE_LENGTH) {
      rejections.push({
        code: 'FIELD_VALUE_TOO_LONG',
        field: name,
        message: `This field holds ${value.length} characters, past the ${MAX_FIELD_VALUE_LENGTH} a form field can carry.`,
      });
      continue;
    }

    values[name] = value;
  }

  return rejections.length > 0
    ? { kind: 'REJECTED', rejections }
    : { kind: 'FIELDS', fields: values, disclosures };
}
