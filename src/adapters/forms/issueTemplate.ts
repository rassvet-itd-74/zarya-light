import fontkit from '@pdf-lib/fontkit';
import { type PDFFont, PDFDocument, rgb } from 'pdf-lib';
import type { OperationType } from '../../domain/intents/intent';
import {
  CONTEXT_LABELS,
  INPUT_HINTS,
  INPUT_LABELS,
  META_LABELS,
  OPERATION_TITLES,
  OPTION_LABELS,
  SECTION_LABELS,
  SENTENCES,
  BRAND,
  labelText,
} from './formLabels';
import {
  CONTEXT_FIELDS,
  FIELD_PLAN,
  FORM_SCHEMA_VERSION,
  META_FIELDS,
  contextFieldsFor,
  inputFieldName,
  templateFieldNames,
} from './formSchema';
import {
  CONTEXT,
  CONTENT_WIDTH,
  LOGO,
  MARGIN,
  PAGE,
  PageCursor,
  ROW,
  TYPE,
  optionRowHeight,
  rowHeight,
} from './templateLayout';

/**
 * An operation to a pre-filled AcroForm PDF. Nothing here signs, reads a chain,
 * or writes to disk — it returns bytes, which is what keeps issuance free of a
 * signer.
 *
 * Assets are **injected, not imported**: Vite's `?inline` resolves to a data URL
 * in a build and a path string under vitest, so an issuer importing its own font
 * would be untestable against the real file.
 *
 * The font is embedded **whole**. pdf-lib's standard fonts cannot encode
 * Cyrillic, and a subset contains only the glyphs this file draws — a member
 * typing a theme whose letters are not among the labels' would see blanks where
 * their own text should be, while the stored value stayed correct. Reasoned
 * rather than observed for forms; observed on the report (`DECISIONS.md`).
 */

export interface TemplateAssets {
  readonly fontRegular: Uint8Array;
  readonly fontBold: Uint8Array;
  /** PNG. `favicon.ico` cannot go in a PDF; the logo is `logo.png`. */
  readonly logoPng: Uint8Array;
}

export interface TemplateRequest {
  readonly operationType: OperationType;
  /**
   * The database key this form is bound to.
   *
   * Issuance does not create it and does not persist it — the caller records
   * the operation **before** asking for a file, because an issued form whose
   * reference was never recorded is unbound in practice (`DECISIONS.md`).
   */
  readonly operationRef: string;
  /**
   * Display values for the context block, keyed by context field name — the
   * same shape `IssuedOperation.context` is compared against on the way back
   * in, so the tamper check compares issuance's own rendering rather than a
   * second one composed elsewhere.
   */
  readonly context: Readonly<Record<string, string>>;
}

export interface IssuedTemplate {
  readonly bytes: Uint8Array;
  /** Every field written, for the caller to record beside the operation. */
  readonly fieldNames: readonly string[];
}

/**
 * Fixed document metadata, so two issuances of one operation are byte-identical.
 *
 * The dates are pinned to the Unix epoch rather than left out: pdf-lib writes
 * no `/CreationDate` by default today, and a template whose reproducibility
 * depends on that staying true is one a library upgrade can break silently.
 * A real timestamp belongs in the operation record, which is queryable, not in
 * a PDF nobody diffs.
 */
const EPOCH = new Date(0);

const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.78, 0.78, 0.82);

/** `support` is the one option group; `matrix` is the other. */
const OPTION_VALUES: Readonly<Record<string, readonly string[]>> = {
  support: ['FOR', 'AGAINST'],
  matrix: ['CATEGORICAL', 'NUMERICAL'],
};

export async function issueTemplate(
  request: TemplateRequest,
  assets: TemplateAssets,
): Promise<IssuedTemplate> {
  // `updateMetadata: false` because pdf-lib's constructor otherwise runs
  // `updateInfoDict`, stamping `ModDate` with `new Date()` and `Producer` with
  // its own string. The explicit setters below would overwrite both anyway, so
  // this is belt and braces — but it is also the option a *reader* needs, and
  // forgetting it there is what makes a load mutate the document it opened.
  const document = await PDFDocument.create({ updateMetadata: false });
  document.registerFontkit(fontkit);

  // See the note above: not subset, so a member's own Cyrillic renders in a
  // viewer that regenerates the appearance.
  const regular = await document.embedFont(assets.fontRegular, { subset: false });
  const bold = await document.embedFont(assets.fontBold, { subset: false });
  const logo = await document.embedPng(assets.logoPng);

  document.setTitle(labelText(OPERATION_TITLES[request.operationType]));
  document.setProducer('zarya-light');
  document.setCreator('zarya-light');
  document.setCreationDate(EPOCH);
  document.setModificationDate(EPOCH);

  let page = document.addPage([PAGE.width, PAGE.height]);
  const cursor = new PageCursor(() => {
    page = document.addPage([PAGE.width, PAGE.height]);
  });
  const form = document.getForm();
  const plan = FIELD_PLAN[request.operationType];

  const text = (
    value: string,
    options: { size: number; font: PDFFont; y: number; x?: number; color?: typeof INK },
  ): void => {
    page.drawText(value, {
      x: options.x ?? MARGIN,
      y: options.y,
      size: options.size,
      font: options.font,
      color: options.color ?? INK,
    });
  };

  // ------------------------------------------------------------------ header
  page.drawImage(logo, {
    x: PAGE.width - MARGIN - LOGO.size,
    y: PAGE.height - MARGIN - LOGO.size,
    width: LOGO.size,
    height: LOGO.size,
  });
  cursor.advance(TYPE.brand);
  text(labelText(BRAND), { size: TYPE.brand, font: bold, y: cursor.y });
  cursor.advance(TYPE.title + 8);
  text(labelText(OPERATION_TITLES[request.operationType]), {
    size: TYPE.title,
    font: bold,
    y: cursor.y,
  });

  // The metadata line is drawn *and* carried as fields. Drawn so a printed form
  // is traceable to its operation; fields because the parser reads the schema
  // version and the reference from field values, not from page content.
  cursor.advance(TYPE.meta + 10);
  const metaValues: Readonly<Record<string, string>> = {
    [META_FIELDS.schemaVersion]: FORM_SCHEMA_VERSION,
    [META_FIELDS.operationRef]: request.operationRef,
    [META_FIELDS.operationType]: request.operationType,
  };
  text(
    Object.entries(META_LABELS)
      .map(([key, label]) => `${labelText(label)}: ${metaValues[`zarya.meta.${key}`]}`)
      .join('   ·   '),
    { size: TYPE.meta, font: regular, y: cursor.y, color: MUTED },
  );

  cursor.advance(6);
  page.drawLine({
    start: { x: MARGIN, y: cursor.y },
    end: { x: MARGIN + CONTENT_WIDTH, y: cursor.y },
    thickness: 0.75,
    color: RULE,
  });

  // The meta fields themselves, off the visible flow: they are read by machine
  // and their values are already printed above, so a second visible copy would
  // invite a member to edit one.
  for (const [fieldName, value] of Object.entries(metaValues)) {
    const field = form.createTextField(fieldName);
    field.setText(value);
    // A 1pt borderless box in the bottom-left corner: inside the printable
    // area so it is a real widget every reader can find, and small enough that
    // nobody tries to write in it. Not placed *in* the margin — a widget
    // outside the content box is one some printers and viewers clip away.
    field.addToPage(page, {
      x: MARGIN,
      y: MARGIN,
      width: 1,
      height: 1,
      font: regular,
      borderWidth: 0,
    });
    field.enableReadOnly();
  }

  const heading = (label: string): void => {
    cursor.reserve(ROW.sectionGap + TYPE.sectionHeading + rowHeight(false));
    cursor.advance(ROW.sectionGap + TYPE.sectionHeading);
    text(label, { size: TYPE.sectionHeading, font: bold, y: cursor.y });
  };

  const sentence = (label: string): void => {
    cursor.advance(TYPE.sentence + 5);
    text(label, { size: TYPE.sentence, font: regular, y: cursor.y, color: MUTED });
  };

  /**
   * Draws one field box at an explicit position, without moving the cursor.
   *
   * Position and flow are separated so a pair of fields can share a row: the
   * caller decides where, and advances once for both.
   */
  const fieldBox = (
    fieldName: string,
    box: { x: number; y: number; width: number },
  ): void => {
    const field = form.createTextField(fieldName);
    field.addToPage(page, {
      x: box.x,
      y: box.y,
      width: box.width,
      height: ROW.fieldHeight,
      font: regular,
      textColor: INK,
      borderColor: RULE,
      borderWidth: 0.75,
    });
  };

  /**
   * A labelled text field across the full width, with an optional hint.
   *
   * The cursor movement here sums to exactly `rowHeight(hint !== undefined)`,
   * which is what `reserve` was given. When the two disagreed, a label could
   * land on one page and its field on the next.
   */
  const textRow = (label: string, hint: string | undefined, fieldName: string): void => {
    cursor.reserve(rowHeight(hint !== undefined));
    cursor.advance(ROW.labelLead + TYPE.label);
    text(label, { size: TYPE.label, font: bold, y: cursor.y });
    cursor.advance(ROW.labelGap);
    if (hint !== undefined) {
      cursor.advance(ROW.hintGap + TYPE.hint);
      text(hint, { size: TYPE.hint, font: regular, y: cursor.y, color: MUTED });
      // `hintDrop` goes *after* the baseline, which is the whole point: the box
      // is placed relative to the cursor, so without this its top edge sits on
      // the baseline and covers the descenders.
      cursor.advance(ROW.hintDrop);
    }
    cursor.advance(ROW.fieldHeight);
    fieldBox(fieldName, { x: MARGIN, y: cursor.y, width: CONTENT_WIDTH });
    cursor.advance(ROW.rowGap);
  };

  /**
   * One application-authored value: `label   value`, drawn, with no widget.
   *
   * The whole point of the block is that it does not look fillable. A member
   * scanning the page sees boxes only where they are meant to write, and there
   * is no ReadOnly flag standing between an editor and a value this application
   * would ignore anyway.
   */
  const contextLine = (label: string, value: string): void => {
    cursor.reserve(CONTEXT.lineHeight);
    cursor.advance(CONTEXT.lineHeight);
    // One segment per line rather than one rule for the block, so a page break
    // between two lines cannot leave a rule running down empty paper.
    page.drawLine({
      start: { x: MARGIN, y: cursor.y - 3.5 },
      end: { x: MARGIN, y: cursor.y + CONTEXT.lineHeight - 3.5 },
      thickness: CONTEXT.ruleWidth,
      color: RULE,
    });
    text(label, { size: TYPE.label, font: bold, y: cursor.y, x: MARGIN + CONTEXT.indent });
    text(value, {
      size: TYPE.contextValue,
      font: regular,
      y: cursor.y,
      x: MARGIN + CONTEXT.indent + CONTEXT.labelWidth,
    });
  };

  const optionRow = (label: string, domainKey: string): void => {
    const options = OPTION_VALUES[domainKey];
    cursor.reserve(optionRowHeight(options.length));
    cursor.advance(ROW.labelLead + TYPE.label);
    text(label, { size: TYPE.label, font: bold, y: cursor.y });

    cursor.advance(ROW.labelGap);
    const group = form.createRadioGroup(inputFieldName(domainKey));
    for (const option of options) {
      cursor.advance(ROW.optionSize + ROW.optionGap);
      // The export value stays as it is — it is what the parser reads. Only the
      // text beside the box is translated.
      group.addOptionToPage(option, page, {
        x: MARGIN,
        y: cursor.y,
        width: ROW.optionSize,
        height: ROW.optionSize,
        borderColor: RULE,
        borderWidth: 0.75,
      });
      text(labelText(OPTION_LABELS[option]), {
        size: TYPE.label,
        font: regular,
        y: cursor.y + 2.5,
        x: MARGIN + ROW.optionSize + 7,
      });
    }
    cursor.advance(ROW.rowGap);
    // Left unselected deliberately: a pre-selected vote is a default opinion.
  };

  // ----------------------------------------------------------------- context
  heading(labelText(SECTION_LABELS.context));
  for (const fieldName of contextFieldsFor(request.operationType)) {
    const key = fieldName.slice('zarya.context.'.length);
    contextLine(labelText(CONTEXT_LABELS[key]), request.context[fieldName] ?? '');
  }

  // ------------------------------------------------------------------- input
  heading(labelText(SECTION_LABELS.input));
  sentence(labelText(SENTENCES.instruction));
  if (plan.input.includes('x') || plan.input.includes('y')) {
    sentence(labelText(SENTENCES.coordinateDisclosure));
  }
  for (const key of plan.input) {
    if (OPTION_VALUES[key] !== undefined) {
      optionRow(labelText(INPUT_LABELS[key]), key);
      continue;
    }
    const hint = INPUT_HINTS[key];
    textRow(
      labelText(INPUT_LABELS[key]),
      hint === undefined ? undefined : labelText(hint),
      inputFieldName(key),
    );
  }

  // No receipt block. The receipt is a stamp drawn onto the returned page when a
  // transaction confirms (`stampReceipt.ts`), so there is nothing to reserve
  // here — and six empty shaded boxes were six boxes a member had to be told not
  // to fill in.

  // Appearances generated once, explicitly, with the embedded font — then the
  // save is told not to do it again with the default one, which cannot encode
  // Cyrillic and would throw.
  form.updateFieldAppearances(regular);

  return {
    bytes: await document.save({ updateFieldAppearances: false }),
    fieldNames: templateFieldNames(request.operationType),
  };
}

/** The context values a template needs, so a caller cannot forget one. */
export const contextValuesFor = (
  operationType: OperationType,
  values: { chainId: string; contract: string; organ?: string; votingId?: string },
): Readonly<Record<string, string>> => {
  const context: Record<string, string> = {};
  for (const fieldName of contextFieldsFor(operationType)) {
    const supplied =
      fieldName === CONTEXT_FIELDS.chainId
        ? values.chainId
        : fieldName === CONTEXT_FIELDS.contract
          ? values.contract
          : fieldName === CONTEXT_FIELDS.organ
            ? values.organ
            : values.votingId;
    if (supplied === undefined) {
      // Issuance fails rather than emitting a form with blank context
      // (`USE_CASES.md`, issuance row 6).
      throw new Error(`a ${operationType} template needs a value for ${fieldName}`);
    }
    context[fieldName] = supplied;
  }
  return context;
};
