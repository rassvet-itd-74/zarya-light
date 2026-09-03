import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { OPERATION_TYPES } from '../../domain/intents/intent';
import {
  LABEL_SLOT_COUNT,
  OPERATION_TITLES,
  SLOT_ENGLISH,
  UnknownLabelSlotError,
  labelFor,
  labelText,
  orphanedWording,
  pendingLabels,
  textFor,
} from './formLabels';
import {
  CONTENT_WIDTH as REPORT_CONTENT_WIDTH,
  LOGO as REPORT_LOGO,
  NARROWEST_COLUMN,
  TYPE as REPORT_TYPE,
} from './reportLayout';
import { CONTENT_WIDTH, HALF_WIDTH, LOGO, ROW, TYPE } from './templateLayout';

/**
 * The wording table, and the two things that could silently go wrong with it.
 *
 * **A typo on either side.** A key misspelled in `wording.ru.txt` lands in
 * `formLabels.ru.ts` doing nothing while its slot stays pending, and both halves
 * look correct in isolation. `orphanedWording()` is the check that catches it.
 *
 * **A string too long for where it is drawn.** Nothing wraps, so it runs off the
 * page. `apply-wording.mjs` refuses to write one, and that is a build script the
 * suite does not run — so the same limits are enforced here, measured in the
 * real font at the real size, against whatever wording is currently applied.
 */

/** prefix -> where that slot is drawn. The authority for both this and the script. */
const GEOMETRY: Readonly<Record<string, { face: 'regular' | 'bold'; size: number; width: number }>> =
  {
    operationTitle: { face: 'bold', size: TYPE.title, width: CONTENT_WIDTH },
    input: { face: 'bold', size: TYPE.label, width: CONTENT_WIDTH },
    hint: { face: 'regular', size: TYPE.hint, width: CONTENT_WIDTH },
    option: { face: 'regular', size: TYPE.label, width: CONTENT_WIDTH - ROW.optionSize - 7 },
    context: { face: 'bold', size: TYPE.label, width: CONTENT_WIDTH },
    receipt: { face: 'bold', size: TYPE.label, width: HALF_WIDTH },
    meta: { face: 'regular', size: TYPE.meta, width: CONTENT_WIDTH / 3 - 60 },
    section: { face: 'bold', size: TYPE.sectionHeading, width: CONTENT_WIDTH },
    sentence: { face: 'regular', size: TYPE.sentence, width: CONTENT_WIDTH },
    brand: { face: 'bold', size: TYPE.brand, width: CONTENT_WIDTH - LOGO.size - 12 },

    // The matrix reference. Landscape, and its column headers are bounded by the
    // narrowest column rather than by the page.
    reportTitle: {
      face: 'bold',
      size: REPORT_TYPE.title,
      width: REPORT_CONTENT_WIDTH - REPORT_LOGO.size - 12,
    },
    reportSection: { face: 'bold', size: REPORT_TYPE.sectionHeading, width: REPORT_CONTENT_WIDTH },
    reportColumn: { face: 'bold', size: REPORT_TYPE.columnHeader, width: NARROWEST_COLUMN },
    reportMeta: { face: 'regular', size: REPORT_TYPE.stamp, width: REPORT_CONTENT_WIDTH / 3 - 90 },
    reportStatus: { face: 'regular', size: REPORT_TYPE.cell, width: 85 },
    reportSentence: { face: 'regular', size: REPORT_TYPE.sentence, width: REPORT_CONTENT_WIDTH },
  };

/** Slots belonging to the report rather than to a form. */
const isReportSlot = (slot: string) => slot.startsWith('report');

let widthOf: (text: string, face: 'regular' | 'bold', size: number) => number;

beforeAll(async () => {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const faces = {
    regular: await document.embedFont(readFileSync('src/assets/pt-sans/PTSans-Regular.ttf')),
    bold: await document.embedFont(readFileSync('src/assets/pt-sans/PTSans-Bold.ttf')),
  };
  widthOf = (text, face, size) => faces[face].widthOfTextAtSize(text, size);
});

const prefixOf = (slot: string) => (slot.includes('.') ? slot.slice(0, slot.indexOf('.')) : slot);

describe('the slot table', () => {
  it('has a geometry for every prefix it uses', () => {
    // A slot with no known geometry cannot be length-checked, so it would be
    // the one that runs off the page.
    for (const slot of Object.keys(SLOT_ENGLISH)) {
      expect(GEOMETRY[prefixOf(slot)], slot).toBeDefined();
    }
  });

  it('covers every operation type', () => {
    for (const type of OPERATION_TYPES) {
      expect(SLOT_ENGLISH[`operationTitle.${type}`], type).toBeDefined();
      expect(OPERATION_TITLES[type]).toBeDefined();
    }
  });

  it('throws for a slot that does not exist', () => {
    // Rather than returning a placeholder: a mistyped key that rendered as
    // `[undefined]` would be a broken label on a printed form with no test to
    // notice it.
    expect(() => labelFor('input.membre')).toThrow(UnknownLabelSlotError);
  });

  it('reports what is still outstanding', () => {
    // A tripwire on the count, split by document so that adding a slot to one
    // does not quietly look like wording arriving for the other.
    const slots = Object.keys(SLOT_ENGLISH);
    expect(slots.filter((slot) => !isReportSlot(slot))).toHaveLength(62);
    expect(slots.filter(isReportSlot)).toHaveLength(37);
    expect(LABEL_SLOT_COUNT).toBe(99);
    expect(pendingLabels().length).toBe(99 - Object.keys(appliedWording()).length);
  });
});

describe('the applied wording', () => {
  it('has no key that no slot claims', () => {
    // The other half of the typo check. A key misspelled in the fill-in file
    // would otherwise sit in the generated module doing nothing.
    expect(orphanedWording()).toEqual([]);
  });

  it('fits where it is drawn, every applied string', () => {
    // Measured, not guessed. This is the check that survives after the build
    // script has done its job — a hand edit to the generated file lands here.
    for (const [slot, text] of Object.entries(appliedWording())) {
      const geometry = GEOMETRY[prefixOf(slot)];
      const width = widthOf(text, geometry.face, geometry.size);
      expect(
        width,
        `${slot} = ${JSON.stringify(text)} is ${Math.round(width)}pt at ${geometry.size}pt, over ${Math.round(geometry.width)}pt`,
      ).toBeLessThanOrEqual(geometry.width);
    }
  });

  it('is covered by the embedded font', () => {
    // Every glyph the templates draw has to exist in PT Sans, or issuance
    // throws at appearance generation rather than at review.
    const drawn = Object.keys(SLOT_ENGLISH)
      .map((slot) => textFor(slot))
      .join('');
    expect(() => widthOf(drawn, 'regular', 10)).not.toThrow();
    expect(() => widthOf(drawn, 'bold', 10)).not.toThrow();
  });
});

describe('a pending slot', () => {
  it('is never a form slot — the forms are worded and must stay that way', () => {
    // The claim that matters, and it survives the report's wording arriving.
    // Asserted as a filter rather than by looping over `pendingLabels()`: an
    // empty loop is a test that checks nothing, and this file had one the moment
    // the form Russian landed.
    expect(pendingLabels().filter((slot) => !isReportSlot(slot))).toEqual([]);
  });

  it('is currently every report slot, because that wording has not arrived', () => {
    // Stated rather than left implicit, so that when the party fills the report
    // section this test fails and gets tightened to an empty list — the same way
    // the form half was.
    expect(pendingLabels()).toHaveLength(37);
    expect(pendingLabels().every(isReportSlot)).toBe(true);
  });

  it('would render bracketed and never blank', () => {
    // The mechanism still matters — a slot added tomorrow falls back to it, and
    // a missing label on a printed form is worse than an obvious placeholder
    // because a member cannot tell the field is unexplained.
    expect(labelText({ kind: 'PENDING', english: 'cast vote' })).toBe('[cast vote]');
    expect(labelText({ kind: 'RU', text: 'Голосование' })).toBe('Голосование');
  });

  it('is what an empty value in the fill-in file produces', () => {
    // Blanking a line in `wording.ru.txt` is the supported way to withdraw
    // wording, so it must not produce an empty label.
    expect(labelText({ kind: 'PENDING', english: 'x' })).toBe('[x]');
  });
});

describe('the build script and the layout agree', () => {
  it('restates the same geometry the layout module defines', () => {
    // `apply-wording.mjs` cannot import TypeScript, so it hard-codes these
    // numbers. Duplication is fine as long as a divergence fails here rather
    // than silently loosening a limit in the checker.
    const script = readFileSync('scripts/apply-wording.mjs', 'utf8');
    const literal = (name: string): number => {
      const match = new RegExp(`${name}:\\s*\\{[^}]*width:\\s*([A-Za-z0-9_. /*+-]+)`).exec(script);
      expect(match, name).not.toBeNull();
      return Function(
        `"use strict"; const CONTENT_WIDTH=${CONTENT_WIDTH}, HALF_WIDTH=${HALF_WIDTH}, OPTION_WIDTH=${
          CONTENT_WIDTH - ROW.optionSize - 7
        }, REPORT_CONTENT_WIDTH=${REPORT_CONTENT_WIDTH}, NARROWEST_COLUMN=${NARROWEST_COLUMN}; return (${match?.[1]});`,
      )() as number;
    };
    for (const [prefix, geometry] of Object.entries(GEOMETRY)) {
      expect(literal(prefix), prefix).toBeCloseTo(geometry.width, 6);
    }
    // And the page constants the script restates, for both orientations.
    expect(script).toContain('595.28 - 42 * 2');
    expect(CONTENT_WIDTH).toBeCloseTo(595.28 - 42 * 2, 6);
    expect(script).toContain('841.89 - 42 * 2');
    expect(REPORT_CONTENT_WIDTH).toBeCloseTo(841.89 - 42 * 2, 6);
    // The narrowest column is a number in two places and a wrong one there would
    // let a header through the checker that overruns its neighbour on paper.
    expect(script).toContain(`NARROWEST_COLUMN = ${NARROWEST_COLUMN}`);
  });
});

/** The Russian currently applied, read through the public surface. */
function appliedWording(): Readonly<Record<string, string>> {
  const applied: Record<string, string> = {};
  for (const slot of Object.keys(SLOT_ENGLISH)) {
    const label = labelFor(slot);
    if (label.kind === 'RU') applied[slot] = label.text;
  }
  return applied;
}
