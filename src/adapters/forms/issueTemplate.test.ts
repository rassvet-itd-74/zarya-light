import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildIntent } from '../../domain/intents/buildIntent';
import { OPERATION_TYPES, type OperationType } from '../../domain/intents/intent';
import { INTENT_SAMPLES } from '../../domain/intents/testing/intentSamples';
import { assembleFormInput } from './assembleFormInput';
import { LABEL_SLOT_COUNT, pendingLabels } from './formLabels';
import { META_FIELDS, RECEIPT_FIELDS, inputFieldName, templateFieldNames } from './formSchema';
import { parseFormFields } from './pdfFormParser';
import { type TemplateAssets, contextValuesFor, issueTemplate } from './issueTemplate';
import { filledForm, issuedOperation } from './testing/formSamples';
import { MARGIN, PAGE } from './templateLayout';

/**
 * Issuance, and the round trip the whole phase was aimed at.
 *
 * The assets are read from the real files rather than stubbed, because the one
 * thing that could not be faked is whether PT Sans encodes what the templates
 * draw. Reading them here is legitimate: this is an adapter test, and the
 * issuer takes bytes precisely so it never has to know where they came from.
 */

const ASSETS: TemplateAssets = {
  fontRegular: readFileSync('src/assets/pt-sans/PTSans-Regular.ttf'),
  fontBold: readFileSync('src/assets/pt-sans/PTSans-Bold.ttf'),
  logoPng: readFileSync('src/assets/logo.png'),
};

const REF = 'op_01HQ3ZS8Q0000000000000000';

const context = (type: OperationType) =>
  contextValuesFor(type, {
    chainId: '11155111',
    contract: '0x6b31cC58a7DC5919f460068cF68D16281F360d25',
    organ: '95.СОВ',
    votingId: '7',
  });

const issue = (type: OperationType) =>
  issueTemplate({ operationType: type, operationRef: REF, context: context(type) }, ASSETS);

describe('an issued template', () => {
  it('carries exactly the fields the schema says it should, for all eleven', async () => {
    // The issuer and the parser read the same constant, so this is really
    // asserting that every name in it survived into a real document.
    for (const type of OPERATION_TYPES) {
      const parsed = await parseFormFields((await issue(type)).bytes);
      expect(parsed.kind, type).toBe('FIELDS');
      const names = parsed.kind === 'FIELDS' ? Object.keys(parsed.fields).sort() : [];
      expect(names, type).toEqual([...templateFieldNames(type)].sort());
    }
  });

  it('passes this application’s own ingestion checks', async () => {
    // `USE_CASES.md`, issuance row 5. The app's output being ingestible by the
    // app is the one property that cannot be true by construction — the two
    // directions are written separately and only meet here.
    for (const type of OPERATION_TYPES) {
      expect((await parseFormFields((await issue(type)).bytes)).kind, type).toBe('FIELDS');
    }
  });

  it('pre-fills the context block and leaves every input empty', async () => {
    const parsed = await parseFormFields((await issue('CREATE_MEMBERSHIP_VOTING')).bytes);
    const fields = parsed.kind === 'FIELDS' ? parsed.fields : {};
    expect(fields['zarya.context.organ']).toBe('95.СОВ');
    expect(fields[META_FIELDS.operationRef]).toBe(REF);
    // Nothing a member is meant to write is written for them.
    expect(fields[inputFieldName('member')]).toBe('');
    expect(fields[inputFieldName('duration')]).toBe('');
  });

  it('leaves the receipt fields present and empty', async () => {
    const parsed = await parseFormFields((await issue('CAST_VOTE')).bytes);
    const fields = parsed.kind === 'FIELDS' ? parsed.fields : {};
    for (const fieldName of Object.values(RECEIPT_FIELDS)) {
      expect(fields, fieldName).toHaveProperty(fieldName, '');
    }
  });

  it('leaves the vote unselected, because a pre-selected vote is an opinion', async () => {
    const parsed = await parseFormFields((await issue('CAST_VOTE')).bytes);
    const fields = parsed.kind === 'FIELDS' ? parsed.fields : {};
    expect(fields[inputFieldName('support')]).toBe('');
  });

  it('fails rather than emitting a form with blank context', async () => {
    // `USE_CASES.md`, issuance row 6. A vote form with no voting number is a
    // form that cannot be completed, and emitting it wastes a member's time.
    expect(() =>
      contextValuesFor('CAST_VOTE', { chainId: '1', contract: '0x00' }),
    ).toThrow(/votingId/);
  });

  it('requires no signer and touches no chain', () => {
    // Checked against the module's **import statements**, not its prose — the
    // first version of this grepped the whole file and failed on the word
    // "signer" inside a comment explaining that there is no signer.
    const source = readFileSync('src/adapters/forms/issueTemplate.ts', 'utf8');
    const joined = source
      .split(/\r?\n/)
      .filter((line) => /^import\b/.test(line) || /^\}? *from '/.test(line.trim()))
      .join(' ');
    for (const forbidden of ['viem', 'ethers', 'node:fs', 'electron', 'Signer']) {
      expect(joined, forbidden).not.toContain(forbidden);
    }
    // And its whole dependency surface is three byte arrays.
    expect(Object.keys(ASSETS).sort()).toEqual(['fontBold', 'fontRegular', 'logoPng']);
  });
});

describe('reproducibility', () => {
  it('produces byte-identical output for the same operation', async () => {
    // `USE_CASES.md`, issuance row 4 — what lets a fixture pin a template.
    const first = await issue('CREATE_NUMERICAL_VALUE_VOTING');
    const second = await issue('CREATE_NUMERICAL_VALUE_VOTING');
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
  });

  it('differs between operations, so the bytes are not a constant', async () => {
    const vote = await issue('CAST_VOTE');
    const membership = await issue('CREATE_MEMBERSHIP_VOTING');
    expect(Buffer.from(vote.bytes).equals(Buffer.from(membership.bytes))).toBe(false);
  });

  it('carries no wall-clock timestamp', async () => {
    // A real date would make every issuance differ. The operation record is
    // where a timestamp belongs, because it can be queried.
    //
    // Read through the object model rather than by grepping the bytes: pdf-lib
    // saves with object streams on, so the info dictionary is compressed and a
    // byte search for `/CreationDate` finds nothing whether it is there or not.
    //
    // `updateMetadata: false` on the **load** is not optional here. pdf-lib's
    // constructor runs `updateInfoDict` by default, which overwrites `ModDate`
    // with `new Date()` and `Producer` with its own string — so a plain load
    // reports the moment the test ran and blames the issuer for it.
    const document = await PDFDocument.load((await issue('CAST_VOTE')).bytes, {
      updateMetadata: false,
    });
    expect(document.getCreationDate()?.getUTCFullYear()).toBe(1970);
    expect(document.getModificationDate()?.getUTCFullYear()).toBe(1970);
    expect(document.getProducer()).toBe('zarya-light');
  });
});

describe('the generated file is clean', () => {
  it('contains no JavaScript, actions, or embedded files', async () => {
    // `INVARIANTS.md`: the app's own output must pass its own checks, and the
    // simplest way to be sure is to not put any of it there.
    const { bytes } = await issue('CREATE_STATEMENT_VOTING');
    const document = await PDFDocument.load(bytes);
    for (const key of ['OpenAction', 'AA', 'Names', 'EmbeddedFiles', 'JavaScript']) {
      expect(document.catalog.get(PDFName.of(key)), key).toBeUndefined();
    }
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).not.toMatch(/\/JS\b/);
    expect(text).not.toMatch(/\/Launch\b/);
    expect(text).not.toMatch(/\/URI\b/);
  });

  it('has no XFA, so it cannot be read two ways', async () => {
    const document = await PDFDocument.load((await issue('CAST_VOTE')).bytes);
    const acroForm = document.catalog.lookup(PDFName.of('AcroForm'));
    expect(acroForm).toBeDefined();
    const parsed = await parseFormFields((await issue('CAST_VOTE')).bytes);
    expect(parsed.kind).toBe('FIELDS');
  });

  it('fits on one page for every operation', async () => {
    // The layout can break to a second page rather than lose a field, so this
    // asserts the intent — not the safety net.
    for (const type of OPERATION_TYPES) {
      const document = await PDFDocument.load((await issue(type)).bytes);
      expect(document.getPageCount(), type).toBe(1);
    }
  });

  it('draws every field inside the printable area', async () => {
    // The assertion the layout constants exist for, and the one that catches a
    // cursor that advanced by a different amount than `reserve` was told: a
    // field pushed below the margin is a field a printer clips and a member
    // never fills in. Checked against the widgets' own rectangles rather than
    // by re-deriving the arithmetic that produced them.
    //
    // The tolerance is the border width, not a fudge factor: `addToPage`
    // inflates a widget's rectangle by the stroke it draws, so a 0.75pt border
    // puts the rect 0.375pt outside the box on every side. Asserting to 0.01
    // failed on exactly that and said nothing about the layout.
    const BORDER = 0.75;
    for (const type of OPERATION_TYPES) {
      const document = await PDFDocument.load((await issue(type)).bytes);
      for (const field of document.getForm().getFields()) {
        for (const widget of field.acroField.getWidgets()) {
          const { x, y, width, height } = widget.getRectangle();
          const where = `${type} ${field.getName()}`;
          expect(x, where).toBeGreaterThanOrEqual(MARGIN - BORDER);
          expect(y, where).toBeGreaterThanOrEqual(MARGIN - BORDER);
          expect(x + width, where).toBeLessThanOrEqual(PAGE.width - MARGIN + BORDER);
          expect(y + height, where).toBeLessThanOrEqual(PAGE.height - MARGIN + BORDER);
        }
      }
    }
  });

  it('never overlaps two fields', async () => {
    // Two boxes on the same spot means one is unreachable, which a page-count
    // check cannot see. The receipt block puts two fields on one row, so this
    // is where that arrangement is actually verified.
    for (const type of OPERATION_TYPES) {
      const document = await PDFDocument.load((await issue(type)).bytes);
      const boxes = document
        .getForm()
        .getFields()
        .flatMap((field) =>
          field.acroField.getWidgets().map((widget) => ({
            name: field.getName(),
            ...widget.getRectangle(),
          })),
        )
        // The 1pt metadata markers sit in the corner together by design.
        .filter((box) => box.width > 2);

      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          const overlaps =
            boxes[a].x < boxes[b].x + boxes[b].width &&
            boxes[b].x < boxes[a].x + boxes[a].width &&
            boxes[a].y < boxes[b].y + boxes[b].height &&
            boxes[b].y < boxes[a].y + boxes[a].height;
          expect(overlaps, `${type}: ${boxes[a].name} over ${boxes[b].name}`).toBe(false);
        }
      }
    }
  });

  it('stays a sane size with the font embedded whole', async () => {
    const { bytes } = await issue('CAST_VOTE');
    // Not subset, so the font dominates. Recorded so a change is visible.
    expect(bytes.length).toBeGreaterThan(200_000);
    expect(bytes.length).toBeLessThan(700_000);
  });
});

describe('the full round trip: issue, fill, ingest', () => {
  /** Fills an issued template the way a member would, then re-saves it. */
  const fill = async (type: OperationType): Promise<Uint8Array> => {
    const document = await PDFDocument.load((await issue(type)).bytes);
    const form = document.getForm();
    const source = filledForm(type);
    for (const key of Object.keys(source)) {
      if (!key.startsWith('zarya.input.')) continue;
      const value = source[key];
      if (value.length === 0) continue;
      const field = form.getField(key);
      if (field.constructor.name === 'PDFRadioGroup') form.getRadioGroup(key).select(value);
      else form.getTextField(key).setText(value);
    }
    // Appearances are left alone: regenerating them needs the embedded font and
    // a real viewer does it itself. The value in `/V` is what intake reads.
    return document.save({ updateFieldAppearances: false });
  };

  it('recovers the exact intent the template was issued for, all eleven', async () => {
    // Issue → fill programmatically → ingest → assert the intent matches. The
    // primary check `zarya-pdf-forms` asks for, now through the real issuer
    // rather than a fixture that only writes field names.
    for (const type of OPERATION_TYPES) {
      const parsed = await parseFormFields(await fill(type));
      expect(parsed.kind, `${type} parse`).toBe('FIELDS');
      if (parsed.kind !== 'FIELDS') continue;

      const assembled = assembleFormInput(parsed.fields, issuedOperation(type));
      expect(assembled.kind, `${type} assemble: ${JSON.stringify(assembled)}`).toBe('INPUT');
      if (assembled.kind !== 'INPUT') continue;

      const built = buildIntent(assembled.operationType, assembled.input);
      expect(built.kind, `${type} build`).toBe('INTENT');
      if (built.kind !== 'INTENT') continue;

      expect(built.intent, type).toEqual(INTENT_SAMPLES[type]);
    }
  });

  it('reports no tampering when the context came from issuance itself', async () => {
    // The tamper check compares the file's display values against the record's.
    // Now that issuance produces both, they have to agree — a mismatch here
    // would mean every real import warned.
    const parsed = await parseFormFields(await fill('CREATE_MEMBERSHIP_VOTING'));
    const assembled =
      parsed.kind === 'FIELDS'
        ? assembleFormInput(parsed.fields, {
            ...issuedOperation('CREATE_MEMBERSHIP_VOTING'),
            context: context('CREATE_MEMBERSHIP_VOTING'),
          })
        : undefined;
    expect(assembled?.kind).toBe('INPUT');
    expect(assembled?.kind === 'INPUT' && assembled.warnings).toEqual([]);
  });

  it('carries Cyrillic through issuance, a viewer’s edit, and back', async () => {
    const parsed = await parseFormFields(await fill('CREATE_THEME_VOTING'));
    const fields = parsed.kind === 'FIELDS' ? parsed.fields : {};
    expect(fields[inputFieldName('theme')]).toBe('Жилищный вопрос');
  });
});

describe('the wording that is still outstanding', () => {
  it('is enumerated rather than remembered', () => {
    // Not an assertion that the count is right — an assertion that the suite
    // can say what it is. When the Russian text lands this drops to zero and
    // the number below changes with it.
    const outstanding = pendingLabels();
    expect(LABEL_SLOT_COUNT).toBe(62);
    expect(outstanding).toHaveLength(61);
    expect(outstanding).toContain('operationTitle.CAST_VOTE');
    expect(outstanding).not.toContain('brand');
  });

  it('renders a pending label visibly bracketed, never blank', async () => {
    // A missing label on a printed form is worse than an obvious placeholder,
    // because a member cannot tell the field is unexplained.
    const { bytes } = await issue('CAST_VOTE');
    const document = await PDFDocument.load(bytes);
    expect(document.getTitle()).toBe('[cast vote]');
  });
});
