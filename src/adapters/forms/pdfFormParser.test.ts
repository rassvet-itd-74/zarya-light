import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { OPERATION_TYPES } from '../../domain/intents/intent';
import { META_FIELDS, RECEIPT_FIELDS, inputFieldName } from './formSchema';
import {
  MAX_FIELDS,
  MAX_FIELD_VALUE_LENGTH,
  MAX_FILE_BYTES,
  type FormParseResult,
  parseFormFields,
} from './pdfFormParser';
import {
  EMPTY_FILE,
  ENCRYPTED_PDF,
  NOT_A_PDF,
  appearanceDisagreesPdf,
  checkboxNamedFieldPdf,
  duplicateNamePdf,
  emptyTemplatePdf,
  flattenedPdf,
  formPdf,
  javascriptActionPdf,
  noFormPdf,
  oversizedValuePdf,
  truncatedPdf,
  xfaPdf,
} from './testing/pdfFixtures';

/**
 * The parser against real PDF bytes, well-formed and hostile.
 *
 * Every assertion about the library's behavior here was observed by probing
 * pdf-lib 1.17.1 before the parser was written, not assumed from its
 * documentation.
 */

const codes = (result: FormParseResult) =>
  result.kind === 'REJECTED' ? result.rejections.map((rejection) => rejection.code) : [];

const fieldsOf = (result: FormParseResult) => (result.kind === 'FIELDS' ? result.fields : {});

describe('a well-formed form', () => {
  it('reads back every field, for all eleven operations', async () => {
    for (const type of OPERATION_TYPES) {
      const result = await parseFormFields(await formPdf(type));
      expect(result.kind, `${type}: ${JSON.stringify(codes(result))}`).toBe('FIELDS');
      expect(fieldsOf(result)[META_FIELDS.operationType], type).toBe(type);
    }
  });

  it('reads a Cyrillic value back byte for byte', async () => {
    // Organ identifiers and governance text are Cyrillic by construction, and a
    // value that survives a round trip mangled is worse than one that fails.
    const result = await parseFormFields(await formPdf('CREATE_THEME_VOTING'));
    expect(fieldsOf(result)[inputFieldName('theme')]).toBe('Жилищный вопрос');
  });

  it('reads a radio group as its export value, not a label', async () => {
    const result = await parseFormFields(await formPdf('CAST_VOTE'));
    expect(fieldsOf(result)[inputFieldName('support')]).toBe('FOR');
  });

  it('reports an unfilled field as blank, not as absent', async () => {
    // The distinction the schema layer depends on: pdf-lib returns `undefined`
    // for a present-but-unfilled field, and passing that through would report a
    // legitimately blank form as flattened.
    const result = await parseFormFields(await emptyTemplatePdf('CAST_VOTE'));
    expect(result.kind).toBe('FIELDS');
    expect(fieldsOf(result)).toHaveProperty(inputFieldName('support'), '');
    expect(fieldsOf(result)).toHaveProperty(RECEIPT_FIELDS.txHash, '');
  });

  it('reports names the schema does not define rather than dropping them', async () => {
    // Vocabulary is the next layer's job, and it can only refuse what it sees.
    const result = await parseFormFields(await formPdf('CAST_VOTE', { 'zarya.stowaway': 'x' }));
    expect(fieldsOf(result)).toHaveProperty('zarya.stowaway', 'x');
  });
});

describe('files that are not governance forms', () => {
  it('rejects an empty file', async () => {
    expect(codes(await parseFormFields(EMPTY_FILE))).toEqual(['EMPTY']);
  });

  it('rejects something that is not a PDF', async () => {
    expect(codes(await parseFormFields(NOT_A_PDF))).toEqual(['UNREADABLE']);
  });

  it('rejects a truncated PDF rather than reading what survived', async () => {
    expect(codes(await parseFormFields(await truncatedPdf()))).toEqual(['UNREADABLE']);
  });

  it('rejects a PDF with no form fields, which is the matrix report’s shape', async () => {
    // Checked on the catalog before `getForm()`, which would otherwise create an
    // AcroForm and make every PDF look like an empty form.
    expect(codes(await parseFormFields(await noFormPdf()))).toEqual(['NOT_A_FORM']);
  });

  it('rejects a file past the size cap without parsing it', async () => {
    const huge = new Uint8Array(MAX_FILE_BYTES + 1);
    // Not even a valid header: the cap is applied before the library is called,
    // so an oversized file is never handed to it.
    expect(codes(await parseFormFields(huge))).toEqual(['TOO_LARGE']);
  });
});

describe('the PDF hazards', () => {
  it('rejects an encrypted form', async () => {
    // Detected by loading with `ignoreEncryption` and checking `isEncrypted`,
    // because pdf-lib's own `EncryptedPDFError` does not survive its CJS build.
    expect(codes(await parseFormFields(ENCRYPTED_PDF))).toEqual(['ENCRYPTED']);
  });

  it('rejects XFA rather than choosing which reader to agree with', async () => {
    expect(codes(await parseFormFields(await xfaPdf('CAST_VOTE')))).toEqual(['XFA_PRESENT']);
  });

  it('says a flattened form is flattened rather than reporting it empty', async () => {
    // Flattening leaves the AcroForm dictionary with no fields behind it, which
    // is how this stays distinguishable from a PDF that never had a form.
    expect(codes(await parseFormFields(await flattenedPdf('CAST_VOTE')))).toEqual(['FLATTENED']);
  });

  it('refuses a duplicate field name instead of taking the first', async () => {
    // pdf-lib will not create one, so the fixture renames a second field after
    // the fact — which is how a hostile file is built, and it proves the refusal
    // is the parser's rather than the generator's.
    const result = await parseFormFields(await duplicateNamePdf());
    expect(codes(result)).toEqual(['DUPLICATE_FIELD_NAME']);
    // And neither value is carried through.
    expect(fieldsOf(result)).toEqual({});
  });

  it('refuses a field type no template uses', async () => {
    // A checkbox wearing a schema name. Reading it would mean deciding what a
    // tick means as a vote.
    const result = await parseFormFields(await checkboxNamedFieldPdf());
    expect(codes(result)).toEqual(['UNSUPPORTED_FIELD_TYPE']);
  });

  it('refuses an oversized field value', async () => {
    const result = await parseFormFields(oversizedValuePdf(MAX_FIELD_VALUE_LENGTH + 1));
    expect(codes(result)).toEqual(['FIELD_VALUE_TOO_LONG']);
  });

  it('rejects rather than crashing on a value that defeats the library', async () => {
    // A 3 MB value throws `RangeError: Maximum call stack size exceeded` inside
    // pdf-lib's string decoding. It has to come back as a rejection, because a
    // caller deciding whether to import must not have to catch an exception.
    const result = await parseFormFields(oversizedValuePdf(3 * 1024 * 1024));
    expect(result.kind).toBe('REJECTED');
    expect(codes(result)).toEqual(['UNREADABLE']);
  });

  it('rejects a form declaring more fields than a governance form has', async () => {
    const document = await PDFDocument.create();
    document.addPage([595, 842]);
    const form = document.getForm();
    for (let index = 0; index <= MAX_FIELDS; index += 1) {
      form.createTextField(`zarya.input.f${index}`).setText('x');
    }
    const result = await parseFormFields(await document.save({ updateFieldAppearances: false }));
    expect(codes(result)).toEqual(['TOO_MANY_FIELDS']);
  });
});

describe('what the parser refuses to do', () => {
  it('never runs JavaScript a form carries, and reads the form anyway', async () => {
    // pdf-lib has no interpreter, so `/OpenAction` and a `/Names` JavaScript
    // tree survive as inert dictionary entries. The form parses normally — the
    // action is data that nothing here looks at.
    const bytes = await javascriptActionPdf('CAST_VOTE');
    const result = await parseFormFields(bytes);
    expect(result.kind).toBe('FIELDS');
    expect(fieldsOf(result)[inputFieldName('support')]).toBe('FOR');

    // And the action really is in the file, so the test is not passing because
    // the fixture failed to add one.
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.catalog.get(PDFName.of('OpenAction'))).toBeDefined();
  });

  it('takes /V as authoritative when the appearance disagrees', async () => {
    // A field's rendered appearance can say something its value does not. The
    // value is what a transaction would be built from, so the value is what is
    // read — and the divergence is not currently surfaced, which is recorded as
    // unverified rather than implied.
    const result = await parseFormFields(await appearanceDisagreesPdf());
    expect(fieldsOf(result)[inputFieldName('member')]).toBe(
      '0x2222222222222222222222222222222222222222',
    );
  });

  it('resolves an incrementally updated value to the newest revision', async () => {
    // A PDF can hold several revisions and the earlier field values remain in
    // the file. The effective value comes from the library's object model, never
    // from scraping bytes.
    const original = await formPdf('CREATE_MEMBERSHIP_VOTING');
    const edited = await PDFDocument.load(original);
    edited
      .getForm()
      .getTextField(inputFieldName('member'))
      .setText('0x3333333333333333333333333333333333333333');
    const result = await parseFormFields(await edited.save({ updateFieldAppearances: false }));
    expect(fieldsOf(result)[inputFieldName('member')]).toBe(
      '0x3333333333333333333333333333333333333333',
    );
  });

  it('never throws, for any input in this suite', async () => {
    const inputs: Uint8Array[] = [
      EMPTY_FILE,
      NOT_A_PDF,
      ENCRYPTED_PDF,
      oversizedValuePdf(3 * 1024 * 1024),
      new Uint8Array(MAX_FILE_BYTES + 1),
      Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
      await truncatedPdf(),
      await xfaPdf('CAST_VOTE'),
      await flattenedPdf('CAST_VOTE'),
      await duplicateNamePdf(),
      await noFormPdf(),
    ];
    for (const bytes of inputs) {
      await expect(parseFormFields(bytes)).resolves.toBeDefined();
    }
  });
});
