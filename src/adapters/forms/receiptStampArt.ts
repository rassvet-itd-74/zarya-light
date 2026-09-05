/**
 * The receipt stamp: its geometry, and the lines it is drawn from.
 *
 * ## One coordinate space for the mark and for the facts
 *
 * pdf-lib has no SVG renderer. `drawSvgPath` understands path data and nothing
 * else — no `<rect>`, no `<circle>`, and **no text** — so a stamp is two things
 * drawn separately: the ruled lines, from the asset, and the six facts, as text.
 * Nothing connects them except that both are positioned from {@link STAMP}.
 *
 * That is why the bands are here rather than as literals at the drawing site. A
 * rule at y = 70 in the asset and a value drawn at y = 72 in the code look
 * correct in two files and wrong on paper, and the only way to notice is to
 * print one. Every number a fact is placed by is a number a line is drawn by.
 *
 * The SVG coordinate space is used throughout: **y points down** from the
 * stamp's top-left corner, which is what `drawSvgPath` expects, so these numbers
 * are the numbers in the asset.
 *
 * ## Sized by the transaction hash
 *
 * 66 characters is the widest thing this stamp will ever hold and it does not
 * wrap, so the hash gets a full-width band to itself and the stamp's width
 * follows from it. `receiptStamp.test.ts` measures it in the embedded font
 * rather than trusting this comment.
 */

/** Points, and the same units as the asset. */
export const STAMP = {
  width: 340,
  height: 170,

  /**
   * The opaque ground, inset just inside the outer rule.
   *
   * The stamp overprints the form — it is applied over whatever is already on
   * the page, and no space is reserved for it — so without this the six facts
   * would be drawn on top of the member's own text and neither would be
   * readable. The frame still lands on page content; the interior does not.
   */
  ground: { inset: 2.4 },

  /** Horizontal rules, from the asset. A band is the space between two of them. */
  bands: {
    title: { top: 7, bottom: 34 },
    hash: { top: 34, bottom: 70 },
    upper: { top: 70, bottom: 94 },
    lower: { top: 94, bottom: 118 },
    signer: { top: 118, bottom: 142 },
    footer: { top: 142, bottom: 163 },
  },

  /** Text columns. `split` is the vertical rule through the paired bands. */
  columns: { left: 14, right: 183, split: 176, rightEdge: 326 },

  type: { title: 13, subtitle: 8.5, label: 6.5, value: 8.5, hash: 8, notice: 6.5 },

  /** Baseline offsets within a band, from its top rule. */
  offsets: { label: 11, value: 20.5 },
} as const;

/** The widest a fact's value may be drawn: a full band, and half of one. */
export const STAMP_BAND_WIDTH = STAMP.columns.rightEdge - STAMP.columns.left;
export const STAMP_HALF_BAND_WIDTH = STAMP.columns.split - STAMP.columns.left;

export interface StampStroke {
  readonly d: string;
  readonly width: number;
}

/**
 * The stroked paths of the asset, in document order.
 *
 * Deliberately not a general SVG parser. It reads `d` and `stroke-width` off
 * `<path>` elements and ignores everything else, because everything else is
 * either unsupported by `drawSvgPath` or not present: the asset is hard blue
 * lines and nothing more. A file containing anything richer would silently lose
 * whatever this cannot see, so it is rejected instead.
 */
export function stampStrokes(svg: Uint8Array): readonly StampStroke[] {
  const text = new TextDecoder().decode(svg);
  const body = text.replace(/<!--[\s\S]*?-->/g, '');

  const unsupported = /<(rect|circle|ellipse|line|polyline|polygon|text|image|use|g)\b/.exec(body);
  if (unsupported !== null) {
    throw new Error(
      `the receipt stamp asset contains <${unsupported[1]}>, which pdf-lib cannot draw — ` +
        'the stamp must be paths only',
    );
  }

  const strokes: StampStroke[] = [];
  for (const tag of body.match(/<path\b[^>]*>/g) ?? []) {
    const d = /\sd="([^"]+)"/.exec(tag);
    if (d === null) continue;
    const width = /\sstroke-width="([\d.]+)"/.exec(tag);
    strokes.push({ d: d[1], width: width === null ? 1 : Number(width[1]) });
  }
  if (strokes.length === 0) throw new Error('the receipt stamp asset contains no paths');
  return strokes;
}
