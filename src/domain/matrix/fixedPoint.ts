/**
 * Decimal text on a form to the `uint64` the contract stores, and back.
 *
 * Lives beside the matrix rather than beside the intents because the scale is a
 * property of the **cell** — `decimals` is stored per numerical cell — and both
 * the intent builder and the matrix report need the same conversion. Putting it
 * with its first consumer would have meant the report importing from `intents/`
 * to render a number.
 *
 * ## The policy is rejection, never rounding
 *
 * `zarya-intents`, and `USE_CASES.md` row 8 of "Form-driven governance": never
 * silently round a governance value. A member who writes `12.345` against a cell
 * configured for two decimals has either misread the cell or means something the
 * cell cannot hold, and both deserve an answer rather than `12.34`. Rounding
 * would turn a typo into a proposal that people vote on.
 *
 * There is no "round half up" option and no flag to enable one. A caller that
 * wants a rounded value must round it itself, visibly, before getting here.
 */

/**
 * A written number, before it has a scale.
 *
 * Strict on purpose, and every exclusion is a real failure mode:
 *
 * - **no sign** — the contract's type is unsigned, and a leading `-` accepted
 *   and then discarded is worse than a rejection;
 * - **no exponent** — `1e3` on a governance form is a transcription accident,
 *   not a quantity;
 * - **no separators** — `1,234` means one thousand two hundred and thirty-four
 *   to one reader and one point two three four to another, and the two differ by
 *   a factor of a thousand;
 * - **no surrounding whitespace here** — trimming is the caller's decision, made
 *   once, rather than a silent normalization buried in a parser.
 */
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export class FixedPointError extends Error {
  constructor(
    message: string,
    readonly received: string,
  ) {
    super(`${message}: received ${JSON.stringify(received)}`);
    this.name = 'FixedPointError';
  }
}

/** `uint64`, the type every matrix value is stored as. */
const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Scales `text` by `decimals` and returns the integer the contract stores.
 *
 * @throws {FixedPointError} on malformed input, on more fraction digits than the
 * scale can hold, or on a result outside `uint64`.
 */
export function parseFixedPoint(text: string, decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new FixedPointError('a decimals scale must be a uint8', String(decimals));
  }

  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    throw new FixedPointError(
      'a value must be digits, optionally followed by a point and more digits, with no sign, exponent or separators',
      text,
    );
  }

  const [, whole, fraction = ''] = match;

  if (fraction.length > decimals) {
    // The message names both numbers, because "too precise" without them sends
    // the member back to the form to guess which way to change it.
    throw new FixedPointError(
      `this cell holds ${decimals} decimal place(s) and this value has ${fraction.length}. ` +
        'It is refused rather than rounded, because a rounded governance value is one nobody chose',
      text,
    );
  }

  const scaled = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (scaled > UINT64_MAX) {
    throw new FixedPointError(
      `scaled by ${decimals} decimal place(s) this exceeds the uint64 the contract stores`,
      text,
    );
  }
  return scaled;
}

/**
 * The inverse, for templates and reports.
 *
 * Exact and total: every `uint64` has one rendering at a given scale, and no
 * information is lost in either direction, so `parseFixedPoint(format(v, d), d)`
 * is `v` for every valid pair. Trailing zeros in the fraction are **kept** —
 * `1.50` at two decimals is the cell's own precision, and trimming it would
 * render a value that no longer round-trips through a form.
 */
export function formatFixedPoint(value: bigint, decimals: number): string {
  if (value < 0n || value > UINT64_MAX) {
    throw new FixedPointError('a stored value must fit in uint64', value.toString());
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new FixedPointError('a decimals scale must be a uint8', String(decimals));
  }
  if (decimals === 0) return value.toString();

  const digits = value.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
