import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildIntent } from '../../domain/intents/buildIntent';
import { OPERATION_TYPES, type OperationType } from '../../domain/intents/intent';
import { INTENT_SAMPLES } from '../../domain/intents/testing/intentSamples';
import { assembleFormInput } from './assembleFormInput';
import { pendingLabels } from './formLabels';
import {
  CONTEXT_FIELDS,
  META_FIELDS,
  RECEIPT_FIELDS,
  inputFieldName,
  templateFieldNames,
} from './formSchema';
import { parseFormFields } from './pdfFormParser';
import { type TemplateAssets, contextValuesFor, issueTemplate } from './issueTemplate';
import { asGlyphs, drawnContent } from './testing/drawnText';
import { filledForm, issuedOperation, resolvedValues } from './testing/formSamples';
import { MARGIN, PAGE, ROW, TYPE } from './templateLayout';

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

  it('leaves every input empty, and carries the reference the parser needs', async () => {
    const parsed = await parseFormFields((await issue('CREATE_MEMBERSHIP_VOTING')).bytes);
    const fields = parsed.kind === 'FIELDS' ? parsed.fields : {};
    expect(fields[META_FIELDS.operationRef]).toBe(REF);
    // Nothing a member is meant to write is written for them.
    expect(fields[inputFieldName('member')]).toBe('');
    expect(fields[inputFieldName('duration')]).toBe('');
  });

  it('carries no receipt or context widget, only meta and inputs', async () => {
    // The rule made visible: every box on the page is a box for the member. The
    // organ, the network and the contract are still on the form — as printed
    // text, checked below — and the receipt arrives later as a stamp.
    const parsed = await parseFormFields((await issue('CREATE_MEMBERSHIP_VOTING')).bytes);
    const fields = parsed.kind === 'FIELDS' ? parsed.fields : {};
    for (const fieldName of [...Object.values(RECEIPT_FIELDS), ...Object.values(CONTEXT_FIELDS)]) {
      expect(fields, fieldName).not.toHaveProperty(fieldName);
    }
    expect(Object.keys(fields).sort()).toEqual(
      [...templateFieldNames('CREATE_MEMBERSHIP_VOTING')].sort(),
    );
  });

  it('prints the context values on the page, where nobody can type over them', async () => {
    // Drawn text, so it is read out of the page's content stream rather than out
    // of a field. That it can be found there at all is the check: a value that
    // stopped being a field and was never drawn would vanish silently, and the
    // member would lose the organ label they are supposed to verify.
    const { bytes } = await issue('CREATE_MEMBERSHIP_VOTING');
    const drawn = await drawnContent(bytes);
    expect(drawn).toContain(asGlyphs('95.СОВ', ASSETS.fontRegular));
    expect(drawn).toContain(
      asGlyphs('0x6b31cC58a7DC5919f460068cF68D16281F360d25', ASSETS.fontRegular),
    );
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

  it('clears a hint’s descenders from the field box under it', () => {
    // The bug this exists for was invisible to every other test here: the boxes
    // were inside the printable area, none overlapped each other, and the page
    // count was right. What was wrong was a box overlapping *drawn text* — the
    // field's top edge sat exactly on the hint's baseline, so «значение оси X
    // из отчёта…» printed with its descenders painted over. Only rendering an
    // issued document in a viewer showed it.
    //
    // Asserted against the font's own metrics rather than a chosen number, so
    // shrinking the clearance or enlarging the hint type fails here.
    // The same file the issuer embeds, read through fontkit's own API rather
    // than pdf-lib's private embedder.
    const font = fontkit.create(ASSETS.fontRegular);
    const descender = (Math.abs(font.descent) / font.unitsPerEm) * TYPE.hint;

    // ~2.07pt for PT Sans at 7.5pt. The first guess at this was 1.6pt, which
    // would have made the old 1.5pt gap look adequate — hence measuring.
    expect(descender).toBeGreaterThan(1.5);
    expect(ROW.hintDrop).toBeGreaterThan(descender);
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

      // The chain read ingestion performs, stood in for by the fixture: the
      // scale of the cell the form addressed. Empty for ten of the eleven.
      const built = buildIntent(assembled.operationType, {
        ...assembled.input,
        ...resolvedValues(type),
      });
      // The problems, never the intent: an intent holds bigints and
      // JSON.stringify refuses them.
      const why = built.kind === 'PROBLEMS' ? JSON.stringify(built.problems) : '';
      expect(built.kind, `${type} build ${why}`).toBe('INTENT');
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

describe('the wording', () => {
  it('is complete, so no form prints a placeholder', () => {
    // This used to assert 61 outstanding. The Russian has landed, so the
    // assertion inverts: a slot falling back to a bracketed placeholder now
    // means a regression rather than work in progress.
    //
    // Scoped to the **forms** rather than to every slot even though the report's
    // wording has now landed too, because this file is about issuance: a report
    // slot going pending must not fail the template tests, and
    // `formLabels.test.ts` owns the stronger claim that nothing at all is
    // pending.
    // The stamp's two slots are outstanding since 2026-09-06 and are excluded
    // here for the same reason report slots are: they are drawn by the stamper,
    // not by issuance, so a template test must not fail on them.
    // `formLabels.test.ts` owns the stronger claim about what is pending.
    expect(
      pendingLabels().filter((slot) => !slot.startsWith('report') && !slot.startsWith('stamp')),
    ).toEqual([]);
  });

  it('titles a form in Russian, in the document metadata as well as on the page', async () => {
    const { bytes } = await issue('CAST_VOTE');
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(document.getTitle()).toBe('Отдача голоса по вопросу');
  });

  it('draws Cyrillic on every form without an encoding failure', async () => {
    // The reason PT Sans is embedded at all: the standard fonts throw
    // `WinAnsi cannot encode "С"`. Now that every label is Cyrillic, issuing
    // all eleven is itself the test that the font covers what they draw.
    for (const type of OPERATION_TYPES) {
      await expect(issue(type)).resolves.toBeDefined();
    }
  });
});
