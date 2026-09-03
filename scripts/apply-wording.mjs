#!/usr/bin/env node
/**
 * Applies `wording.ru.txt` to `src/adapters/forms/formLabels.ru.ts`.
 *
 * The party fills in a plain text file; this turns it into the module the
 * templates read. Regenerating the whole file rather than patching it means the
 * two cannot drift, and it makes applying 61 strings one reviewable diff instead
 * of 61 hand edits.
 *
 * It refuses to write on any of these, because each one produces a form that is
 * wrong in a way nobody would notice on screen:
 *
 * - **an unknown key** — a typo would sit in the generated file doing nothing
 *   while its slot stayed pending, and both halves would look right alone;
 * - **a duplicate key** — two values for one slot, and which wins is an
 *   accident of line order;
 * - **a value too long for where it is drawn** — nothing wraps, so it runs off
 *   the page. The limit is measured in PT Sans at that slot's real size and
 *   width, not guessed.
 *
 * A missing key is reported but not fatal: leaving a slot for later is a
 * legitimate state, and it renders bracketed.
 *
 * Usage:
 *   node scripts/apply-wording.mjs [--check]
 *
 * `--check` validates and reports without writing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'wording.ru.txt');
const TARGET = join(root, 'src', 'adapters', 'forms', 'formLabels.ru.ts');

const checkOnly = process.argv.includes('--check');

/**
 * Geometry, restated from `templateLayout.ts`.
 *
 * Duplicated deliberately: this is a build script and importing TypeScript from
 * it would mean a compile step to check a text file. The numbers are asserted
 * against the real module by `formLabels.test.ts`, so a divergence fails the
 * suite rather than silently loosening a limit here.
 */
const CONTENT_WIDTH = 595.28 - 42 * 2;
const HALF_WIDTH = (CONTENT_WIDTH - 14) / 2;
const OPTION_WIDTH = CONTENT_WIDTH - 12 - 7;

/**
 * The report is landscape, so it has its own content width — and a table, so its
 * headers are bounded by the **narrowest column** rather than by the page.
 *
 * `NARROWEST_COLUMN` is restated from `reportLayout.ts` for the same reason the
 * form geometry is: this is a build script and importing TypeScript would mean a
 * compile step to check a text file. `formLabels.test.ts` asserts these against
 * the real modules, so a divergence fails the suite.
 */
const REPORT_CONTENT_WIDTH = 841.89 - 42 * 2;
const NARROWEST_COLUMN = 70;

/** prefix -> { face, size, width } for the slot's drawn position. */
const GEOMETRY = {
  operationTitle: { face: 'bold', size: 13, width: CONTENT_WIDTH },
  input: { face: 'bold', size: 9, width: CONTENT_WIDTH },
  hint: { face: 'regular', size: 7.5, width: CONTENT_WIDTH },
  option: { face: 'regular', size: 9, width: OPTION_WIDTH },
  context: { face: 'bold', size: 9, width: CONTENT_WIDTH },
  receipt: { face: 'bold', size: 9, width: HALF_WIDTH },
  // Three labels and their three values share one 7pt line.
  meta: { face: 'regular', size: 7, width: CONTENT_WIDTH / 3 - 60 },
  section: { face: 'bold', size: 10.5, width: CONTENT_WIDTH },
  sentence: { face: 'regular', size: 8, width: CONTENT_WIDTH },
  brand: { face: 'bold', size: 16, width: CONTENT_WIDTH - 36 - 12 },

  // The report. Landscape, so its sentences have real room — unlike a form's,
  // where every string is squeezed against a 511pt column.
  reportTitle: { face: 'bold', size: 12, width: REPORT_CONTENT_WIDTH - 30 - 12 },
  reportSection: { face: 'bold', size: 10, width: REPORT_CONTENT_WIDTH },
  reportColumn: { face: 'bold', size: 7, width: NARROWEST_COLUMN },
  // Three label/value pairs share the stamp line.
  reportMeta: { face: 'regular', size: 7.5, width: REPORT_CONTENT_WIDTH / 3 - 90 },
  // Drawn inside a table cell; the narrowest one that shows a status is `value`.
  reportStatus: { face: 'regular', size: 7.5, width: 85 },
  reportSentence: { face: 'regular', size: 8, width: REPORT_CONTENT_WIDTH },
};

const KEY_LINE = /^([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)?)\s*=\s*(.*)$/;

function parse(text) {
  const values = new Map();
  const problems = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) return;

    const match = KEY_LINE.exec(line);
    if (match === null) {
      problems.push(`line ${index + 1}: not a "key = value" line and not a comment: ${line}`);
      return;
    }
    const [, key, value] = match;
    if (values.has(key)) {
      problems.push(`line ${index + 1}: ${key} is set twice`);
      return;
    }
    // Trailing whitespace is dropped, inner whitespace is the party's.
    values.set(key, value.trim());
  });

  return { values, problems };
}

async function measurer() {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const faces = {
    regular: await document.embedFont(
      readFileSync(join(root, 'src/assets/pt-sans/PTSans-Regular.ttf')),
    ),
    bold: await document.embedFont(readFileSync(join(root, 'src/assets/pt-sans/PTSans-Bold.ttf'))),
  };
  return (text, { face, size }) => faces[face].widthOfTextAtSize(text, size);
}

const emit = (values) => {
  const lines = [
    '/**',
    ' * Russian wording for the form templates.',
    ' *',
    ' * GENERATED — do not edit by hand. Regenerate with:',
    ' *',
    ' * ```',
    ' * npm run wording:apply',
    ' * ```',
    ' *',
    ' * which reads `wording.ru.txt` at the repository root and rewrites this file',
    ' * whole. Editing here instead means the next regeneration silently discards the',
    ' * change, and the fill-in file is the artefact the party actually reviews.',
    ' *',
    ' * An absent or empty entry leaves its slot pending, which renders bracketed on',
    ' * the page. See `formLabels.ts`.',
    ' */',
    'export const RU_WORDING: Readonly<Record<string, string>> = {',
  ];
  for (const [key, value] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
    if (value.length === 0) continue;
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('};', '');
  return lines.join('\n');
};

async function main() {
  let text;
  try {
    text = readFileSync(SOURCE, 'utf8');
  } catch {
    console.error(`cannot read ${SOURCE} — the fill-in file is missing`);
    process.exit(1);
  }

  // The slot list is the authority on which keys exist. Read out of the
  // TypeScript source by pattern rather than imported, for the same reason the
  // geometry is restated: no compile step to check a text file.
  const slotSource = readFileSync(join(root, 'src/adapters/forms/formLabels.ts'), 'utf8');
  const slotBlock = slotSource.slice(
    slotSource.indexOf('export const SLOT_ENGLISH'),
    slotSource.indexOf('export class UnknownLabelSlotError'),
  );
  const slots = new Set(
    [...slotBlock.matchAll(/^\s*(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*))\s*:/gm)].map(
      (match) => match[1] ?? match[2],
    ),
  );
  if (slots.size === 0) {
    console.error('could not read SLOT_ENGLISH out of formLabels.ts');
    process.exit(1);
  }

  const { values, problems } = parse(text);
  const measure = await measurer();

  for (const key of values.keys()) {
    if (!slots.has(key)) problems.push(`${key}: no such label slot`);
  }

  for (const [key, value] of values) {
    if (value.length === 0) continue;
    const prefix = key.includes('.') ? key.slice(0, key.indexOf('.')) : key;
    const geometry = GEOMETRY[prefix];
    if (geometry === undefined) {
      problems.push(`${key}: no geometry known for prefix ${prefix}`);
      continue;
    }
    const width = measure(value, geometry);
    if (width > geometry.width) {
      problems.push(
        `${key}: ${Math.round(width)}pt wide at ${geometry.size}pt, ` +
          `over the ${Math.round(geometry.width)}pt available — it would run off the page`,
      );
    }
  }

  const filled = [...values].filter(([, value]) => value.length > 0);
  const missing = [...slots].filter((slot) => {
    const value = values.get(slot);
    return value === undefined || value.length === 0;
  });

  if (problems.length > 0) {
    console.error(`refusing to apply — ${problems.length} problem(s):\n`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }

  console.log(`${filled.length} of ${slots.size} slots worded.`);
  if (missing.length > 0) {
    console.log(`still outstanding (${missing.length}): ${missing.join(', ')}`);
  }

  if (checkOnly) {
    console.log('--check: nothing written.');
    return;
  }

  writeFileSync(TARGET, emit(new Map(filled)), 'utf8');
  console.log(`wrote ${TARGET}`);
}

await main();
