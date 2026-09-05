/**
 * A4 geometry for an issued template, as numbers with reasons.
 *
 * Separate from the issuer because it is the part worth arguing about on its
 * own: how wide a field is decides whether a member can read back what they
 * wrote, and a page that silently overflows loses a field rather than looking
 * wrong.
 *
 * A4 because the party is Russian and every printer it will meet is metric.
 * Points throughout, since that is the only unit PDF has — 72 to the inch.
 */

/** 210 × 297 mm in points. */
export const PAGE = { width: 595.28, height: 841.89 } as const;

/** ~15 mm, which every consumer printer can reach. */
export const MARGIN = 42;

export const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

export const TYPE = {
  /** The application name. */
  brand: 16,
  /** The operation this form is for. */
  title: 13,
  sectionHeading: 10.5,
  label: 9,
  hint: 7.5,
  /** Inside a field's own appearance. */
  fieldValue: 10,
  sentence: 8,
  /** An application-authored value, drawn as text rather than held in a field. */
  contextValue: 10,
  /** The metadata line, present to be read back rather than read. */
  meta: 7,
} as const;

/**
 * The application block: `label   value` on one line, with a rule down the left.
 *
 * These values used to be shaded read-only text fields, which is the problem
 * this replaced. A member looking at a page of boxes cannot tell which ones are
 * theirs, and the ReadOnly flag is advisory — it stops a viewer, not a person
 * with any other tool. Drawing them as text makes the distinction one a reader
 * can name without being told: **a box means write here; a line of text does
 * not.**
 *
 * The rule is what keeps the block reading as a block once the boxes are gone.
 */
export const CONTEXT = {
  /** From the left margin to the label, leaving room for the rule. */
  indent: 10,
  /** The label column. The value starts after it, so values line up. */
  labelWidth: 150,
  /** Between the label's column and the label itself, so nothing touches. */
  gap: 8,
  /** One line, at the value's size with room above and below. */
  lineHeight: 15,
  ruleWidth: 2,
} as const;

/** How wide a context label may be drawn. Enforced by the wording checker. */
export const CONTEXT_LABEL_WIDTH = CONTEXT.labelWidth - CONTEXT.gap;

export const ROW = {
  /** A text field's box. 16pt fits a 10pt value with room above and below. */
  fieldHeight: 16,
  /** Above a label, separating it from the row before. */
  labelLead: 4,
  /** Between a label and its field. */
  labelGap: 2,
  /** Above a hint, separating it from the label. */
  hintGap: 1.5,
  /**
   * Below a hint's **baseline**, clearing its descenders from the field box.
   *
   * Without this the box's top edge landed exactly on the hint baseline and
   * painted over every descender — «значение оси X из отчёта…» rendered sliced
   * through, on every hinted field of every form the app had issued. Found by
   * rendering an issued document in a viewer, not by a test: the fields were
   * inside the printable area and no two overlapped, so nothing asserted here
   * was false.
   *
   * 2.5pt against a measured 2.07pt descender at 7.5pt PT Sans — the same order
   * of clearance `labelGap` gives a 9pt label. The figure is measured from the
   * embedded font in `issueTemplate.test.ts`, not chosen: a first estimate of
   * ~1.6pt would have made the old 1.5pt gap look adequate when it is not.
   */
  hintDrop: 2.5,
  /** Between one field and the next label. */
  rowGap: 5,
  /** Before a section heading. */
  sectionGap: 14,
  /** An option box, square and small enough to sit beside 9pt text. */
  optionSize: 12,
  optionGap: 5,
} as const;

/** Square, top-right, ~13 mm. The 120 px source lands near 240 DPI at this size. */
export const LOGO = { size: 36 } as const;

/**
 * A downward cursor with a page break, so a template can never lose a field.
 *
 * Every current form fits one page, and this exists because "fits" is a fact
 * about today's field counts rather than a property of the code. A form that
 * grows past a page gets a second one instead of writing a field below the
 * paper.
 */
export class PageCursor {
  private cursorY: number;

  constructor(
    private readonly onNewPage: () => void,
    top: number = PAGE.height - MARGIN,
  ) {
    this.cursorY = top;
  }

  get y(): number {
    return this.cursorY;
  }

  /** Moves down by `amount`, breaking the page first if it would not fit. */
  advance(amount: number): number {
    this.cursorY -= amount;
    return this.cursorY;
  }

  /**
   * Guarantees `needed` points remain, starting a page if not.
   *
   * Called with the height of a whole row rather than of its next line, so a
   * label never ends up on one page with its field on the next.
   */
  reserve(needed: number): void {
    if (this.cursorY - needed < MARGIN) {
      this.onNewPage();
      this.cursorY = PAGE.height - MARGIN;
    }
  }
}

/**
 * The height one labelled text field occupies, hint included.
 *
 * This has to equal exactly what the issuer advances the cursor by. When the
 * two disagreed, `reserve` under-reserved and a label could end up on one page
 * with its field on the next — so both are computed from these constants and
 * a test compares the prediction against the real cursor movement.
 */
export const rowHeight = (hasHint: boolean): number =>
  ROW.labelLead +
  TYPE.label +
  ROW.labelGap +
  (hasHint ? ROW.hintGap + TYPE.hint + ROW.hintDrop : 0) +
  ROW.fieldHeight +
  ROW.rowGap;

/** The height an option group occupies, given how many options it has. */
export const optionRowHeight = (options: number): number =>
  ROW.labelLead +
  TYPE.label +
  ROW.labelGap +
  options * (ROW.optionSize + ROW.optionGap) +
  ROW.rowGap;
