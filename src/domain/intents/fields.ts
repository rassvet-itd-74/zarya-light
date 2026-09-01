import { type EvmAddress, evmAddress } from '../primitives';

/**
 * Reading raw text into domain values, one field at a time, collecting every
 * problem instead of stopping at the first.
 *
 * A form is filled by a person who then walks away. Reporting "the member
 * address is malformed", waiting for them to fix it, and then reporting "the
 * duration is not a number" costs two round trips through a human, so every
 * field is read and every problem is kept.
 *
 * ## What this layer is not allowed to do
 *
 * No chain reads, no clock, no storage — `zarya-intents`: never put network
 * reads in schema validation. Everything here is a decision about *shape*, which
 * means the same input always produces the same result and a validation failure
 * is never an outage. Whether the organ exists, whether the signer may act, and
 * whether the value fits the cell are all preflight's questions.
 *
 * The keys are **domain vocabulary**, not form field names. `adapters/forms/`
 * owns the `zarya.input.*` schema and maps it onto these, so the domain cannot
 * read a PDF and the schema can be versioned without touching this file.
 */

export interface FieldProblem {
  /** The domain key, which the form adapter maps back to a field name for display. */
  readonly field: string;
  /** One line, safe to show a user. Never echoes an unbounded input back. */
  readonly message: string;
}

/** Raw text keyed by domain name, exactly as a human wrote it. */
export type IntentInput = Readonly<Record<string, string | undefined>>;

/**
 * Bounds on free text.
 *
 * The contract imposes none — these strings are stored unbounded and paid for in
 * gas — so every limit here is this client's. They are generous enough not to
 * refuse a real theme and small enough that a hostile form cannot carry a
 * megabyte through parsing into the database.
 */
export const TEXT_LIMITS = {
  /** A column heading. */
  theme: 200,
  /** A row proposition. */
  statement: 400,
  /** A category label beside a numeric id. */
  categoryName: 64,
} as const;

/** `uint64`, the width of every matrix value and category id. */
const UINT64_MAX = (1n << 64n) - 1n;
/** `uint8`, the width of a decimals setting. */
const UINT8_MAX = 255n;

const UNSIGNED_INTEGER = /^\d+$/;

/**
 * Control characters, which a PDF field can carry and no governance text needs.
 *
 * Rejects the C0 and C1 control ranges plus the bidirectional overrides and
 * isolates. The overrides are the interesting ones: they let a stored statement
 * render in an order different from the one it is read back in, which is a way
 * to make a proposal display as something other than what people voted on.
 *
 * Built from a string rather than written as a regular expression literal, so no
 * control character appears in this file — a literal one is invisible in review
 * and does not survive every editor.
 */
// `no-control-regex` exists to catch a control character someone pasted in by
// accident. Here they are the subject: a rule that rejects them has to name them.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTERS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]');

export class FieldReader {
  private readonly problems: FieldProblem[] = [];

  constructor(private readonly input: IntentInput) {}

  /** Every problem found so far, in the order the fields were read. */
  get failures(): readonly FieldProblem[] {
    return this.problems;
  }

  get ok(): boolean {
    return this.problems.length === 0;
  }

  private fail(field: string, message: string): undefined {
    this.problems.push({ field, message });
    return undefined;
  }

  /**
   * The raw value, trimmed, or a problem if it is absent or blank.
   *
   * Trimming is applied once, here, rather than inside each parser: a form field
   * routinely picks up a trailing space and no governance value is distinguished
   * by one.
   */
  private present(field: string): string | undefined {
    const raw = this.input[field];
    if (raw === undefined) return this.fail(field, 'This field is required and was not supplied.');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return this.fail(field, 'This field is required and was left blank.');
    return trimmed;
  }

  address(field: string): EvmAddress | undefined {
    const text = this.present(field);
    if (text === undefined) return undefined;
    try {
      return evmAddress(text);
    } catch {
      return this.fail(field, 'This must be an Ethereum address — 0x followed by 40 hex characters.');
    }
  }

  /**
   * An address that must not be the zero address.
   *
   * Used for `valueAuthor`, where the contract does not check it and the
   * consequence is quiet: a checkpoint encodes as `author << 64 | value`, and
   * `get*ValueAtTimestamp` treats an encoded zero as **not found**
   * (`Matricies.sol:398-413`). So a value of `0` authored by `0x00…00` is
   * written successfully and then reads back as though it had never been
   * written. Refusing the zero author makes that unreachable.
   */
  nonZeroAddress(field: string): EvmAddress | undefined {
    const address = this.address(field);
    if (address === undefined) return undefined;
    if (/^0x0{40}$/i.test(address)) {
      return this.fail(field, 'This must be a real address; the zero address is not accepted here.');
    }
    return address;
  }

  /**
   * A non-negative integer in decimal.
   *
   * `BigInt` rather than `Number`, and a regular expression rather than a
   * constructor: `BigInt(' 12 ')` succeeds, `Number('12abc')` is `NaN` but
   * `parseInt('12abc')` is `12`, and a value that parses partially is how a typo
   * becomes a different proposal.
   */
  uint(field: string, max: bigint = UINT64_MAX): bigint | undefined {
    const text = this.present(field);
    if (text === undefined) return undefined;
    if (!UNSIGNED_INTEGER.test(text)) {
      return this.fail(
        field,
        'This must be a whole number, with no sign, decimal point, spaces or separators.',
      );
    }
    const value = BigInt(text);
    if (value > max) {
      return this.fail(field, `This is larger than the maximum this field accepts (${max}).`);
    }
    return value;
  }

  /** A `uint8`, returned as a `number` because that is what the ABI takes. */
  uint8(field: string): number | undefined {
    const value = this.uint(field, UINT8_MAX);
    return value === undefined ? undefined : Number(value);
  }

  /**
   * A `uint256` coordinate. No client ceiling below the contract's, because
   * nothing reports the matrix size and inventing a bound would refuse
   * coordinates the chain accepts.
   */
  coordinate(field: string): bigint | undefined {
    return this.uint(field, (1n << 256n) - 1n);
  }

  /**
   * A count of seconds. Shape only — the *bound* is client policy and lives in
   * `preflight/durationPolicy.ts`, so a refusal it produces is labelled as this
   * client's rather than as something the contract said.
   */
  duration(field: string): number | undefined {
    const value = this.uint(field, BigInt(Number.MAX_SAFE_INTEGER));
    return value === undefined ? undefined : Number(value);
  }

  /**
   * Free text, bounded and normalized by two documented rules and no others:
   * surrounding whitespace is removed, and the result is normalized to Unicode
   * **NFC**.
   *
   * NFC matters for Cyrillic. `й` can be written as one code point or as `и`
   * plus a combining breve, and the two are visually identical, compare unequal,
   * and would produce two different dedup keys for one proposal. Precomposing
   * makes identity match what a reader sees.
   *
   * The length bound is applied **after** normalization, since that is the text
   * that will be stored.
   */
  text(field: string, limit: number): string | undefined {
    const raw = this.present(field);
    if (raw === undefined) return undefined;
    const normalized = raw.normalize('NFC');
    if (normalized.length > limit) {
      return this.fail(field, `This must be at most ${limit} characters; it is ${normalized.length}.`);
    }
    if (FORBIDDEN_CHARACTERS.test(normalized)) {
      return this.fail(
        field,
        'This contains control or text-direction characters, which are not accepted in governance text.',
      );
    }
    return normalized;
  }

  /**
   * One of a fixed set of values, compared exactly.
   *
   * No case folding and no trimming beyond the standard one: a form radio group
   * emits its own export values, so a mismatch means the file was edited rather
   * than that a user typed carelessly. `zarya-pdf-forms` refuses to fuzzy-match
   * a field name, and this refuses to fuzzy-match a field value.
   */
  choice<T extends string>(field: string, allowed: readonly T[]): T | undefined {
    const text = this.present(field);
    if (text === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(text)) {
      return this.fail(field, `This must be one of: ${allowed.join(', ')}.`);
    }
    return text as T;
  }

  /** Records a problem discovered by a rule that spans more than one field. */
  reject(field: string, message: string): undefined {
    return this.fail(field, message);
  }
}
