import type { OrganResolver } from '../ports/OrganResolver';
import type {
  CellValue,
  MatrixSnapshotReader,
  ReadPoint,
} from '../ports/MatrixSnapshotReader';
import type { Bytes32 } from '../primitives';
import { formatFixedPoint } from './fixedPoint';
import {
  type AxisLabel,
  type CategoricalCell,
  type CellBinding,
  type MatrixCoordinate,
  type MatrixKind,
  MATRIX_KINDS,
  type NumericalCell,
  attributeValue,
  coordinateKey,
} from './matrix';
import type { AxisEntry, CoordinateIndex } from './matrixIndex';

/**
 * The printable matrix reference, assembled.
 *
 * This is the read model behind the one document a voter consults *before*
 * filling anything in: it says which `(x, y)` exist and what is in them, because
 * a form asks for coordinates and the contract cannot be asked what coordinates
 * there are.
 *
 * Domain rather than adapter, and the split is load-bearing. Which cells appear,
 * in what order, with which fields, and what is said when a read fails are all
 * decisions about what the document *claims* — testable here against fake
 * readers. Turning the model into ink is the `MatrixReportWriter`'s problem.
 *
 * ## Every degradation is on the page, and none of them is silent
 *
 * A reference sheet that quietly dropped a row would be worse than one that
 * failed, because a voter would read a complete-looking page and conclude a cell
 * does not exist. So a failed read becomes a visible marker on the row it
 * belongs to, and the coordinates — the thing the voter actually needs — survive
 * every failure below them. The one total failure is **nothing readable at all**:
 * there was work to do and not one read answered, which is an outage rather than
 * an empty matrix, and the two must not print the same.
 *
 * ## Staleness is a correctness property here, not a disclaimer
 *
 * Someone will type coordinates from a month-old printout. Two things make that
 * safe rather than merely warned about: every page carries the block and chain
 * timestamp the reads were pinned to, and preflight re-validates coordinates at
 * submission, so a stale coordinate produces a clear refusal rather than a wrong
 * transaction. The second is why the first can be a fact rather than a promise.
 */

/** A field whose read did not answer. Rendered as unavailable, never as absent. */
export type UnreadField = 'CELL' | 'THEME' | 'STATEMENT' | 'VALUE' | 'CATEGORY_NAME';

/**
 * How to print a cell's owning organ.
 *
 * `UNRESOLVED` exists because the reverse table is a local enumeration bounded at
 * local organ number 99, and an organ outside it is a real organ this client
 * simply cannot name. Showing the hash is the honest rendering; guessing a label
 * would attribute a cell to the wrong body, and dropping the row would hide
 * coordinates a voter needs.
 */
export type OrganDisplay =
  | { readonly kind: 'UNBOUND' }
  | { readonly kind: 'LABELLED'; readonly organ: Bytes32; readonly label: string }
  | { readonly kind: 'UNRESOLVED'; readonly organ: Bytes32 }
  | { readonly kind: 'UNREAD' };

export interface CategoryDisplay {
  readonly category: bigint;
  /** `undefined` when the name read failed; `UNSET` when the cell named nothing. */
  readonly name: AxisLabel | undefined;
}

/**
 * A cell's current value, ready to print.
 *
 * `text` is scaled by the cell's own `decimals` for a numerical cell and left as
 * the bare integer for a categorical one, where the stored number *is* a
 * category and a decimal point would be nonsense. `raw` is kept beside it
 * because the scaled text is what a voter transcribes and the integer is what
 * the chain holds, and a support conversation needs both.
 */
export type ValueDisplay =
  | { readonly kind: 'NONE' }
  | {
      readonly kind: 'SET';
      readonly text: string;
      readonly raw: bigint;
      readonly value: Extract<CellValue, { kind: 'SET' }>;
      /** For a categorical cell, the name of the category now held. */
      readonly categoryName: AxisLabel | undefined;
    }
  | { readonly kind: 'UNREAD' };

export interface ReportRow {
  readonly matrix: MatrixKind;
  readonly at: MatrixCoordinate;
  /** `undefined` means the read failed; `UNSET` means the axis is genuinely unlabelled. */
  readonly theme: AxisLabel | undefined;
  readonly statement: AxisLabel | undefined;
  readonly organ: OrganDisplay;
  readonly binding: CellBinding | undefined;
  /** Categorical cells only. */
  readonly categories: readonly CategoryDisplay[];
  /** Numerical cells only, and meaningful only for a bound cell. */
  readonly decimals: number | undefined;
  readonly value: ValueDisplay;
  readonly sampleCount: bigint | undefined;
  readonly unread: readonly UnreadField[];
}

/**
 * An axis label, with what the chain says about it beside what the index does.
 *
 * The creation event carries the label text, so the inventory is populated
 * without a read — but a later voting at the same coordinate overwrites, and the
 * index only knows about the votings inside its cursor. Confirming costs one
 * call and turns a possibly-stale label into a stated agreement or a stated
 * disagreement.
 */
export type AxisConfirmation =
  | { readonly kind: 'MATCHES' }
  /** The chain holds different text. The index is behind, or projecting the wrong deployment. */
  | { readonly kind: 'DIFFERS'; readonly onChain: string }
  /** The index says there is a label here and the chain says there is none. */
  | { readonly kind: 'ABSENT_ON_CHAIN' }
  | { readonly kind: 'UNREAD' };

export interface AxisInventoryEntry {
  readonly coordinate: bigint;
  /** As the winning voting worded it. */
  readonly text: string;
  readonly confirmation: AxisConfirmation;
}

export interface AxisInventory {
  readonly themes: readonly AxisInventoryEntry[];
  readonly statements: readonly AxisInventoryEntry[];
}

export interface MatrixReport {
  /** The block every read was pinned to, and its chain timestamp. */
  readonly readAt: ReadPoint;
  /**
   * How far behind the pinned block the coordinate index is.
   *
   * `undefined` when the index is level with the pin or ahead of it. A positive
   * value means a cell created in the gap is **missing** from the page — the one
   * direction of incompleteness this design accepts, and it is disclosed rather
   * than absorbed. See `ZaryaMatrixSnapshot` for why the pin is not the cursor.
   */
  readonly indexBehindBy: bigint | undefined;
  readonly rows: readonly ReportRow[];
  readonly axes: { readonly [K in MatrixKind]: AxisInventory };
  /** Rows carrying at least one unread field, for a warning the renderer can lead with. */
  readonly degradedRows: number;
  /**
   * True when the index found no coordinate and no axis label.
   *
   * A normal state for a young matrix, and the reason it is a flag rather than
   * an error: the axis inventory is what a voter needs in order to propose a
   * *new* value, and it is the part that gets populated first.
   */
  readonly empty: boolean;
}

export type MatrixReportOutcome =
  | { readonly kind: 'REPORT'; readonly report: MatrixReport }
  /**
   * There were cells to describe and not one read answered.
   *
   * Distinct from an empty matrix, which reads and finds nothing — printing an
   * outage as an empty matrix would tell a voter their party has no matrix. Also
   * distinct from an outage during which only the *axis* inventory has content:
   * that half comes from the events themselves and is printed, because
   * withholding the party's own themes over a network blip helps nobody.
   */
  | { readonly kind: 'FAILED'; readonly reason: 'NOTHING_READABLE' };

export interface MatrixReportInputs {
  readonly index: CoordinateIndex;
  readonly snapshot: MatrixSnapshotReader;
  /** The reverse half of `OrganResolver` — synchronous, local, allowed to fail. */
  readonly organs: Pick<OrganResolver, 'label'>;
  /** Highest block the index has projected, for the gap disclosure. */
  readonly indexedThrough?: bigint;
  /** How many reads may be in flight at once. */
  readonly concurrency?: number;
}

/**
 * Ten at a time.
 *
 * A full report is several reads per cell, and firing all of them at once is how
 * a public RPC endpoint starts rate-limiting halfway through — which would turn
 * a legible document into a page of unread markers. Ten keeps a realistic matrix
 * to a few seconds without ever looking like a flood.
 */
const DEFAULT_CONCURRENCY = 10;

export async function assembleMatrixReport(
  inputs: MatrixReportInputs,
): Promise<MatrixReportOutcome> {
  const { index, snapshot, organs } = inputs;
  const reads = new ReadTally();
  const axisCache = new AxisCache(snapshot, reads);

  const targets = await resolveTargets(index, snapshot, reads);
  const rows = await mapWithLimit(
    targets,
    inputs.concurrency ?? DEFAULT_CONCURRENCY,
    (target) => buildRow(target, snapshot, organs, axisCache, reads),
  );

  const axes = Object.fromEntries(
    await Promise.all(
      MATRIX_KINDS.map(
        async (kind) =>
          [
            kind,
            {
              themes: await confirmAxis(index.themes[kind], (x) => axisCache.theme(kind, x)),
              statements: await confirmAxis(index.statements[kind], (y) =>
                axisCache.statement(kind, y),
              ),
            },
          ] as const,
      ),
    ),
  ) as { readonly [K in MatrixKind]: AxisInventory };

  // The failure condition is narrower than "no read answered", and the reason is
  // that the two halves of this document have different sources.
  //
  // The **axis inventory** is event-derived: the creation events carry the label
  // text, so it is real content even when every confirming call times out, and
  // refusing to print it would withhold the party's own themes over a network
  // blip. The **cell table** is read-derived: a row whose every field is unread
  // carries nothing but a coordinate.
  //
  // So a page that would be nothing but empty rows is refused, and one that
  // still has an inventory is printed with its confirmations marked unread.
  if (reads.attempted > 0 && reads.answered === 0 && rows.length > 0) {
    return { kind: 'FAILED', reason: 'NOTHING_READABLE' };
  }

  const empty =
    rows.length === 0 &&
    MATRIX_KINDS.every(
      (kind) => axes[kind].themes.length === 0 && axes[kind].statements.length === 0,
    );

  return {
    kind: 'REPORT',
    report: {
      readAt: snapshot.at,
      indexBehindBy: behindBy(inputs.indexedThrough, snapshot.at.blockNumber),
      rows,
      axes,
      degradedRows: rows.filter((row) => row.unread.length > 0).length,
      empty,
    },
  };
}

const behindBy = (indexedThrough: bigint | undefined, pinned: bigint): bigint | undefined => {
  if (indexedThrough === undefined) return undefined;
  return indexedThrough < pinned ? pinned - indexedThrough : undefined;
};

/**
 * Counts reads so that "an outage" and "an empty matrix" cannot print the same.
 *
 * Every read in this module goes through it, which is why it is a tally rather
 * than a flag: one successful read out of two hundred is still a report, and
 * zero out of two hundred is not.
 */
class ReadTally {
  attempted = 0;
  answered = 0;

  record<T>(value: T | undefined): T | undefined {
    this.attempted += 1;
    if (value !== undefined) this.answered += 1;
    return value;
  }
}

/**
 * Axis labels, read once each.
 *
 * Themes are addressed by `x` and statements by `y`, so every cell in a column
 * shares one theme read and every cell in a row shares one statement read. On a
 * matrix of any size that is the difference between a handful of calls and one
 * per cell — and it is only sound because the snapshot is **pinned**: caching a
 * moving read would be caching two different blocks under one key.
 */
class AxisCache {
  private readonly themes = new Map<string, Promise<AxisLabel | undefined>>();
  private readonly statements = new Map<string, Promise<AxisLabel | undefined>>();

  constructor(
    private readonly snapshot: MatrixSnapshotReader,
    private readonly reads: ReadTally,
  ) {}

  theme(kind: MatrixKind, x: bigint): Promise<AxisLabel | undefined> {
    return this.cached(this.themes, `${kind}:${x}`, () =>
      this.snapshot.theme(kind, x).then((label) => this.reads.record(label)),
    );
  }

  statement(kind: MatrixKind, y: bigint): Promise<AxisLabel | undefined> {
    return this.cached(this.statements, `${kind}:${y}`, () =>
      this.snapshot.statement(kind, y).then((label) => this.reads.record(label)),
    );
  }

  private cached<T>(into: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
    const existing = into.get(key);
    if (existing !== undefined) return existing;
    const created = make();
    into.set(key, created);
    return created;
  }
}

/** A coordinate plus the matrix it has been established to belong to. */
interface RowTarget {
  readonly matrix: MatrixKind;
  readonly at: MatrixCoordinate;
  /** Already read while attributing, so the row does not read it twice. */
  readonly cell: CategoricalCell | NumericalCell | undefined;
  readonly cellRead: boolean;
}

/**
 * Turns the index into the list of rows to build.
 *
 * The attributed coordinates come straight through. The unattributed ones —
 * everything learned from `ValueAdded`, which carries no `isCategorical` — cost
 * one pair of cell reads each, and `attributeValue` decides from both readings.
 *
 * An `AMBIGUOUS` coordinate, bound in both matrices, becomes **two rows**. That
 * is the "show both or neither" rule: no read can say which matrix a given
 * `ValueAdded` came from, so presenting one would be a coin flip printed as a
 * fact, and presenting neither would hide a coordinate that exists twice.
 */
async function resolveTargets(
  index: CoordinateIndex,
  snapshot: MatrixSnapshotReader,
  reads: ReadTally,
): Promise<readonly RowTarget[]> {
  const targets: RowTarget[] = [];
  const claimed = new Set<string>();

  const claim = (matrix: MatrixKind, at: MatrixCoordinate): boolean => {
    const key = `${matrix}:${coordinateKey(at)}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  };

  for (const at of index.coordinates.categorical) {
    if (claim('CATEGORICAL', at)) {
      targets.push({ matrix: 'CATEGORICAL', at, cell: undefined, cellRead: false });
    }
  }
  for (const at of index.coordinates.numerical) {
    if (claim('NUMERICAL', at)) {
      targets.push({ matrix: 'NUMERICAL', at, cell: undefined, cellRead: false });
    }
  }

  for (const at of index.coordinates.unattributed) {
    const [categorical, numerical] = await Promise.all([
      snapshot.categoricalCell(at).then((cell) => reads.record(cell)),
      snapshot.numericalCell(at).then((cell) => reads.record(cell)),
    ]);
    const attribution = attributeValue(categorical?.binding, numerical?.binding);

    switch (attribution.kind) {
      case 'CATEGORICAL':
        if (claim('CATEGORICAL', at)) {
          targets.push({ matrix: 'CATEGORICAL', at, cell: categorical, cellRead: true });
        }
        break;
      case 'NUMERICAL':
        if (claim('NUMERICAL', at)) {
          targets.push({ matrix: 'NUMERICAL', at, cell: numerical, cellRead: true });
        }
        break;
      case 'AMBIGUOUS':
        if (claim('CATEGORICAL', at)) {
          targets.push({ matrix: 'CATEGORICAL', at, cell: categorical, cellRead: true });
        }
        if (claim('NUMERICAL', at)) {
          targets.push({ matrix: 'NUMERICAL', at, cell: numerical, cellRead: true });
        }
        break;
      case 'UNKNOWN':
        // The event named this coordinate, so it exists. Which matrix could not
        // be established — either a read failed or both cells read unbound,
        // which for a coordinate `ValueAdded` really named means the reads and
        // the log disagree. Either way the coordinate is what the voter needs,
        // so it is printed under both matrices with the cell marked unread
        // rather than dropped.
        for (const matrix of MATRIX_KINDS) {
          if (claim(matrix, at)) {
            targets.push({
              matrix,
              at,
              cell: matrix === 'CATEGORICAL' ? categorical : numerical,
              cellRead: true,
            });
          }
        }
        break;
    }
  }

  return targets.sort(
    (a, b) =>
      MATRIX_KINDS.indexOf(a.matrix) - MATRIX_KINDS.indexOf(b.matrix) ||
      compareBigints(a.at.x, b.at.x) ||
      compareBigints(a.at.y, b.at.y),
  );
}

async function buildRow(
  target: RowTarget,
  snapshot: MatrixSnapshotReader,
  organs: Pick<OrganResolver, 'label'>,
  axes: AxisCache,
  reads: ReadTally,
): Promise<ReportRow> {
  const { matrix, at } = target;
  const cell = target.cellRead
    ? target.cell
    : reads.record(
        matrix === 'CATEGORICAL'
          ? await snapshot.categoricalCell(at)
          : await snapshot.numericalCell(at),
      );

  const [theme, statement, value] = await Promise.all([
    axes.theme(matrix, at.x),
    axes.statement(matrix, at.y),
    snapshot.latestValue(matrix, at).then((read) => reads.record(read)),
  ]);

  const categorical = matrix === 'CATEGORICAL' ? (cell as CategoricalCell | undefined) : undefined;
  const numerical = matrix === 'NUMERICAL' ? (cell as NumericalCell | undefined) : undefined;

  const categories = await mapWithLimit(
    categorical?.allowedCategories ?? [],
    4,
    async (category): Promise<CategoryDisplay> => ({
      category,
      name: reads.record(await snapshot.categoryName(at, category)),
    }),
  );

  const unread: UnreadField[] = [];
  if (cell === undefined) unread.push('CELL');
  if (theme === undefined) unread.push('THEME');
  if (statement === undefined) unread.push('STATEMENT');
  if (value === undefined) unread.push('VALUE');
  if (categories.some((entry) => entry.name === undefined)) unread.push('CATEGORY_NAME');

  return {
    matrix,
    at,
    theme,
    statement,
    organ: organDisplay(cell?.binding, organs),
    binding: cell?.binding,
    categories,
    // Only for a bound cell: an untouched numerical cell reads `0`, which is
    // also a legitimate configured scale, and the two are indistinguishable.
    decimals: numerical?.binding.kind === 'BOUND' ? numerical.decimals : undefined,
    value: valueDisplay(matrix, value, numerical?.decimals ?? 0, categories),
    sampleCount: cell?.sampleLength,
    unread,
  };
}

const organDisplay = (
  binding: CellBinding | undefined,
  organs: Pick<OrganResolver, 'label'>,
): OrganDisplay => {
  if (binding === undefined) return { kind: 'UNREAD' };
  if (binding.kind === 'UNBOUND') return { kind: 'UNBOUND' };
  const label = organs.label(binding.organ);
  return label === undefined
    ? { kind: 'UNRESOLVED', organ: binding.organ }
    : { kind: 'LABELLED', organ: binding.organ, label };
};

function valueDisplay(
  matrix: MatrixKind,
  value: CellValue | undefined,
  decimals: number,
  categories: readonly CategoryDisplay[],
): ValueDisplay {
  if (value === undefined) return { kind: 'UNREAD' };
  if (value.kind === 'NONE') return { kind: 'NONE' };

  // A categorical cell's stored number *is* a category, so it is never scaled —
  // `2` at two decimals would print as `0.02` and name a category nobody chose.
  const text =
    matrix === 'CATEGORICAL' ? value.value.toString() : safeFormat(value.value, decimals);

  return {
    kind: 'SET',
    text,
    raw: value.value,
    value,
    categoryName:
      matrix === 'CATEGORICAL'
        ? categories.find((entry) => entry.category === value.value)?.name
        : undefined,
  };
}

/**
 * A cell whose stored value and configured scale disagree still prints.
 *
 * `formatFixedPoint` throws outside `uint64` or a `uint8` scale, and both are
 * reachable here without a bug in this client: the value comes from a read that
 * may have decoded oddly, and a report is not the place to discover it by
 * crashing. The raw integer is always shown beside the scaled text anyway.
 */
const safeFormat = (value: bigint, decimals: number): string => {
  try {
    return formatFixedPoint(value, decimals);
  } catch {
    return value.toString();
  }
};

const confirmAxis = async (
  entries: readonly AxisEntry[],
  read: (coordinate: bigint) => Promise<AxisLabel | undefined>,
): Promise<readonly AxisInventoryEntry[]> =>
  Promise.all(
    entries.map(async (entry) => ({
      coordinate: entry.coordinate,
      text: entry.text,
      confirmation: confirmationOf(entry.text, await read(entry.coordinate)),
    })),
  );

const confirmationOf = (indexed: string, onChain: AxisLabel | undefined): AxisConfirmation => {
  if (onChain === undefined) return { kind: 'UNREAD' };
  if (onChain.kind === 'UNSET') return { kind: 'ABSENT_ON_CHAIN' };
  return onChain.text === indexed ? { kind: 'MATCHES' } : { kind: 'DIFFERS', onChain: onChain.text };
};

/**
 * `Promise.all` with a ceiling.
 *
 * Order-preserving, because the output is a printed table and a row order that
 * depended on which read finished first would make two reports of one matrix
 * disagree.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError('concurrency must be at least 1');
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await map(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const compareBigints = (a: bigint, b: bigint): number => (a === b ? 0 : a < b ? -1 : 1);
