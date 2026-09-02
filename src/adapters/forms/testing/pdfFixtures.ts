import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { OperationType } from '../../../domain/intents/intent';
import { CONTEXT_FIELDS, META_FIELDS, RECEIPT_FIELDS, inputFieldName } from '../formSchema';
import { filledForm } from './formSamples';

/**
 * PDFs for the parser's tests — the well-formed ones built with the library, the
 * hostile ones written by hand.
 *
 * **This is not issuance.** It writes field names and values and nothing else:
 * no logo, no embedded font, no layout, no page furniture, no `operationRef`
 * persisted first, and no reproducibility guarantee. Real issuance replaces it
 * and these fixtures then have something to be compared against. Keeping the two
 * apart is deliberate — a parser test that depends on the issuer passes for the
 * wrong reason when the issuer is wrong.
 *
 * The hostile files cannot come from a library at all: nothing well-behaved
 * emits a corrupted cross-reference table, a duplicate field name, or an
 * `/Encrypt` entry with no cipher behind it. Those are string literals, which is
 * also why they are readable in review.
 */

/** `support` is the one option group; every other field is text. */
const RADIO_FIELDS = new Set([inputFieldName('support')]);

const RADIO_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  [inputFieldName('support')]: ['FOR', 'AGAINST'],
};

/**
 * A field-bearing PDF for one operation, filled from the same sample values the
 * schema tests use.
 *
 * Saved with `updateFieldAppearances: false`, which is what lets a Cyrillic
 * value survive without an embedded font: the value lives in `/V` as a PDF
 * string and only the *appearance* needs glyphs. Issuance cannot take that
 * shortcut — a printed form with no appearance is blank — which is why the font
 * is slice 3's problem and not this file's.
 */
export async function formPdf(
  operationType: OperationType,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Promise<Uint8Array> {
  const fields = filledForm(operationType, overrides);
  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  const form = document.getForm();

  for (const [name, value] of Object.entries(fields)) {
    if (RADIO_FIELDS.has(name)) {
      const group = form.createRadioGroup(name);
      for (const option of RADIO_OPTIONS[name]) {
        group.addOptionToPage(option, page, { x: 20, y: 20, width: 12, height: 12 });
      }
      // An unselected group is a person who did not tick anything, which reads
      // back as blank rather than as a missing field.
      if (value.length > 0) group.select(value);
    } else {
      const field = form.createTextField(name);
      if (value.length > 0) field.setText(value);
    }
  }

  return document.save({ updateFieldAppearances: false });
}

/** The template's field names with no values at all, as an unfilled template. */
export async function emptyTemplatePdf(operationType: OperationType): Promise<Uint8Array> {
  const blanked: Record<string, string> = {};
  for (const name of Object.keys(filledForm(operationType))) blanked[name] = '';
  return formPdf(operationType, blanked);
}

/** A valid form, flattened — field appearances baked into the page. */
export async function flattenedPdf(operationType: OperationType): Promise<Uint8Array> {
  const document = await PDFDocument.load(await formPdf(operationType));
  document.getForm().flatten();
  return document.save();
}

/** A valid form with `/XFA` added to its AcroForm dictionary. */
export async function xfaPdf(operationType: OperationType): Promise<Uint8Array> {
  const document = await PDFDocument.load(await formPdf(operationType));
  const acroForm = document.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  acroForm.set(PDFName.of('XFA'), PDFString.of('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>'));
  return document.save({ updateFieldAppearances: false });
}

/**
 * Two fields sharing one name, forced at the dictionary level.
 *
 * pdf-lib refuses to *create* a duplicate, so the second field is renamed after
 * the fact — which is how a hostile file would be built, and it proves the
 * refusal is the parser's rather than the generator's politeness.
 *
 * The rename has to happen at the **leaf**. pdf-lib stores a dotted name as a
 * `/Parent` chain — `zarya.input.member` is a node `zarya`, a node `input`, and
 * a leaf `member` — and `getName()` composes the chain back. So the decoy is
 * created as a sibling under the same `zarya.input` parent and only its leaf
 * `/T` is changed; setting the leaf to the full dotted name instead produces
 * `zarya.input.zarya.input.member`, which is a different field and not a
 * duplicate at all.
 */
export async function duplicateNamePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([595, 842]);
  const form = document.getForm();
  form.createTextField(inputFieldName('member')).setText('0x1111111111111111111111111111111111111111');
  const decoy = form.createTextField(inputFieldName('decoy'));
  decoy.setText('0x2222222222222222222222222222222222222222');
  decoy.acroField.dict.set(PDFName.of('T'), PDFString.of('member'));
  return document.save({ updateFieldAppearances: false });
}

/** A form carrying a field type no template uses, under a schema name. */
export async function checkboxNamedFieldPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  const form = document.getForm();
  const box = form.createCheckBox(inputFieldName('support'));
  box.addToPage(page, { x: 20, y: 20, width: 12, height: 12 });
  box.check();
  return document.save({ updateFieldAppearances: false });
}

/** A form with `/OpenAction` running JavaScript, plus a `/Names` JavaScript tree. */
export async function javascriptActionPdf(operationType: OperationType): Promise<Uint8Array> {
  const document = await PDFDocument.load(await formPdf(operationType));
  const action = document.context.obj({
    Type: 'Action',
    S: 'JavaScript',
    JS: PDFString.of('app.alert("this must never run");'),
  });
  document.catalog.set(PDFName.of('OpenAction'), document.context.register(action));
  const names = document.context.obj({
    JavaScript: document.context.obj({ Names: PDFArray.withContext(document.context) }),
  });
  document.catalog.set(PDFName.of('Names'), document.context.register(names));
  return document.save({ updateFieldAppearances: false });
}

/** A form whose `/V` disagrees with the appearance stream already generated. */
export async function appearanceDisagreesPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([595, 842]);
  const form = document.getForm();
  const field = form.createTextField(inputFieldName('member'));
  // Appearance generated for the decoy...
  field.setText('0x1111111111111111111111111111111111111111');
  const withAppearance = await document.save();

  // ...then `/V` replaced without regenerating it.
  const edited = await PDFDocument.load(withAppearance);
  edited
    .getForm()
    .getTextField(inputFieldName('member'))
    .acroField.dict.set(
      PDFName.of('V'),
      PDFString.of('0x2222222222222222222222222222222222222222'),
    );
  return edited.save({ updateFieldAppearances: false });
}

const latin1 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'latin1'));

/**
 * An encrypted document. Hand-written because generating a real one needs a
 * cipher, and the only thing under test is that an `/Encrypt` entry is refused
 * before any string is read — the strings here are not even ciphertext.
 */
export const ENCRYPTED_PDF = latin1(`%PDF-1.7
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj
4 0 obj<</Filter/Standard/V 1/R 2/O<0000>/U<0000>/P -1>>endobj
trailer<</Size 5/Root 1 0 R/Encrypt 4 0 R>>
%%EOF`);

export const NOT_A_PDF = latin1('this is a text file that someone renamed');

export const EMPTY_FILE = new Uint8Array(0);

/** A PDF with pages and no AcroForm — the shape the matrix report will have. */
export async function noFormPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage([595, 842]);
  return document.save();
}

/** Truncated mid-object, so the cross-reference table points past the end. */
export async function truncatedPdf(): Promise<Uint8Array> {
  const bytes = await formPdf('CAST_VOTE');
  return bytes.slice(0, Math.floor(bytes.length / 2));
}

/**
 * A single field value of `size` bytes, in a hand-written document.
 *
 * Built by hand because pdf-lib cannot *write* a value this large — it blows the
 * stack — and the point is what happens when a file already contains one.
 */
export function oversizedValuePdf(size: number): Uint8Array {
  return latin1(`%PDF-1.7
1 0 obj<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[5 0 R]>>>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj
5 0 obj<</FT/Tx/T(${inputFieldName('member')})/V(${'y'.repeat(size)})>>endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF`);
}

/** Every field name a template carries, for assertions about coverage. */
export const TEMPLATE_NAMESPACES = {
  META_FIELDS,
  CONTEXT_FIELDS,
  RECEIPT_FIELDS,
};
