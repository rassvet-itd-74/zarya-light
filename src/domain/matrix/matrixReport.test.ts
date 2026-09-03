import { describe, expect, it, vi } from 'vitest';
import type {
  CellValue,
  MatrixSnapshotReader,
  ReadPoint,
} from '../ports/MatrixSnapshotReader';
import type { OrganResolver } from '../ports/OrganResolver';
import { type Bytes32, bytes32, evmAddress, unixSeconds } from '../primitives';
import {
  type AxisLabel,
  type CategoricalCell,
  type MatrixCoordinate,
  type MatrixKind,
  type NumericalCell,
  axisLabel,
  cellBinding,
  coordinateKey,
  matrixCoordinate,
} from './matrix';
import {
  type MatrixIndexEvent,
  emptyMatrixIndexState,
  foldMatrixIndexWindow,
} from './matrixIndex';
import { assembleMatrixReport } from './matrixReport';

/**
 * The report is a document a voter transcribes coordinates from, so these tests
 * are mostly about what it is not allowed to claim: a coordinate it cannot
 * confirm, a freshness the chain did not assert, an organ it guessed at, or an
 * outage dressed as an empty matrix.
 */

const ORGAN = bytes32(`0x${'11'.repeat(32)}`);
const UNLISTED_ORGAN = bytes32(`0x${'ab'.repeat(32)}`);
const AUTHOR = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');

/** Block 900 at a real Sepolia-shaped timestamp, so nothing resembles Date.now(). */
const READ_AT: ReadPoint = { blockNumber: 900n, timestamp: unixSeconds(1_756_000_000) };

interface SnapshotFixture {
  readonly categorical?: Readonly<Record<string, CategoricalCell | undefined>>;
  readonly numerical?: Readonly<Record<string, NumericalCell | undefined>>;
  readonly themes?: Readonly<Record<string, AxisLabel | undefined>>;
  readonly statements?: Readonly<Record<string, AxisLabel | undefined>>;
  readonly categoryNames?: Readonly<Record<string, AxisLabel | undefined>>;
  readonly values?: Readonly<Record<string, CellValue | undefined>>;
  readonly at?: ReadPoint;
}

/**
 * A snapshot reader whose every read is a lookup with an explicit miss.
 *
 * A missing key answers `undefined` — "the read did not answer" — which is what
 * makes the degradation tests write themselves: leaving a key out *is* the
 * failure being tested.
 */
const snapshotOf = (fixture: SnapshotFixture): MatrixSnapshotReader => ({
  at: fixture.at ?? READ_AT,
  categoricalCell: async (at) => fixture.categorical?.[coordinateKey(at)],
  numericalCell: async (at) => fixture.numerical?.[coordinateKey(at)],
  theme: async (kind, x) => fixture.themes?.[`${kind}:${x}`],
  statement: async (kind, y) => fixture.statements?.[`${kind}:${y}`],
  categoryName: async (at, category) =>
    fixture.categoryNames?.[`${coordinateKey(at)}:${category}`],
  latestValue: async (kind, at) => fixture.values?.[`${kind}:${coordinateKey(at)}`],
});

const organsKnowing = (...known: readonly Bytes32[]): Pick<OrganResolver, 'label'> => ({
  label: (organ) => (known.includes(organ) ? '74.СОВ' : undefined),
});

const indexOf = (...events: readonly MatrixIndexEvent[]) =>
  foldMatrixIndexWindow(emptyMatrixIndexState(), [...events]).index;

const position = (blockNumber: bigint, logIndex = 0) => ({ blockNumber, logIndex });

const categoryAdded = (at: MatrixCoordinate, category: bigint): MatrixIndexEvent => ({
  kind: 'CATEGORY_ADDED',
  at,
  category,
  position: position(10n),
});

const valueAdded = (at: MatrixCoordinate): MatrixIndexEvent => ({
  kind: 'VALUE_ADDED',
  at,
  value: 1n,
  author: AUTHOR,
  position: position(10n),
});

const themeApplied = (
  matrix: MatrixKind,
  x: bigint,
  text: string,
  votingId = 1n,
): readonly MatrixIndexEvent[] => [
  { kind: 'THEME_PROPOSED', votingId, matrix, x, text, position: position(10n) },
  { kind: 'VOTING_FINALIZED', votingId, success: true, position: position(100n) },
];

const categoricalCell = (
  organ: Bytes32 | undefined,
  allowedCategories: readonly bigint[],
  sampleLength = 0n,
): CategoricalCell => ({
  binding: cellBinding(organ ?? bytes32(`0x${'0'.repeat(64)}`)),
  allowedCategories,
  sampleLength,
});

const numericalCell = (
  organ: Bytes32 | undefined,
  decimals: number,
  sampleLength = 0n,
): NumericalCell => ({
  binding: cellBinding(organ ?? bytes32(`0x${'0'.repeat(64)}`)),
  decimals,
  sampleLength,
});

const reportOf = async (
  index: ReturnType<typeof indexOf>,
  fixture: SnapshotFixture,
  extra: { indexedThrough?: bigint; organs?: Pick<OrganResolver, 'label'> } = {},
) => {
  const outcome = await assembleMatrixReport({
    index,
    snapshot: snapshotOf(fixture),
    organs: extra.organs ?? organsKnowing(ORGAN),
    ...(extra.indexedThrough === undefined ? {} : { indexedThrough: extra.indexedThrough }),
  });
  if (outcome.kind !== 'REPORT') throw new Error(`expected a report, got ${outcome.reason}`);
  return outcome.report;
};

describe('an empty matrix', () => {
  it('is a valid report rather than an error or a blank page', async () => {
    const report = await reportOf(indexOf(), {});

    expect(report.empty).toBe(true);
    expect(report.rows).toEqual([]);
    expect(report.readAt).toEqual(READ_AT);
  });

  it('is not confused with an outage — nothing was read, so nothing failed', async () => {
    // The distinction FAILED exists for. An empty index attempts no reads, so a
    // zero success count here is not evidence of anything.
    const outcome = await assembleMatrixReport({
      index: indexOf(),
      snapshot: snapshotOf({}),
      organs: organsKnowing(),
    });

    expect(outcome.kind).toBe('REPORT');
  });

  it('stops being empty when the axes are populated but no cell is', async () => {
    // The state a young matrix is actually in, and the inventory is what a voter
    // needs in order to propose the first value.
    const report = await reportOf(indexOf(...themeApplied('NUMERICAL', 3n, 'Бюджет')), {
      themes: { 'NUMERICAL:3': axisLabel('Бюджет') },
    });

    expect(report.empty).toBe(false);
    expect(report.rows).toEqual([]);
    expect(report.axes.NUMERICAL.themes).toEqual([
      { coordinate: 3n, text: 'Бюджет', confirmation: { kind: 'MATCHES' } },
    ]);
  });
});

describe('the staleness stamp', () => {
  it('carries the pinned block and its chain timestamp, not the system clock', async () => {
    const before = Math.floor(Date.now() / 1000);
    const report = await reportOf(indexOf(), {});

    expect(report.readAt.blockNumber).toBe(900n);
    expect(report.readAt.timestamp).toBe(1_756_000_000);
    // The fixture's timestamp is fixed and in the past; a system clock would
    // land within a second of now.
    expect(Math.abs(report.readAt.timestamp - before)).toBeGreaterThan(60);
  });

  it('discloses how far the coordinate index is behind the pinned block', async () => {
    // The one direction of incompleteness the design accepts: a cell created in
    // the gap is missing rather than misdescribed, and the page says so.
    const report = await reportOf(indexOf(), {}, { indexedThrough: 850n });

    expect(report.indexBehindBy).toBe(50n);
  });

  it('discloses nothing when the index is level with the pin or ahead of it', async () => {
    expect((await reportOf(indexOf(), {}, { indexedThrough: 900n })).indexBehindBy).toBeUndefined();
    expect((await reportOf(indexOf(), {}, { indexedThrough: 950n })).indexBehindBy).toBeUndefined();
  });
});

describe('the axis inventory is confirmed, not merely projected', () => {
  const index = indexOf(...themeApplied('CATEGORICAL', 1n, 'Бюджет'));

  it('reports agreement between the winning voting and the chain', async () => {
    const report = await reportOf(index, { themes: { 'CATEGORICAL:1': axisLabel('Бюджет') } });

    expect(report.axes.CATEGORICAL.themes[0].confirmation).toEqual({ kind: 'MATCHES' });
  });

  it('reports a disagreement with the chain’s own text, rather than picking one', async () => {
    // The index only knows votings inside its cursor, so different text on chain
    // means a later voting it has not seen — or the wrong deployment entirely.
    const report = await reportOf(index, { themes: { 'CATEGORICAL:1': axisLabel('Расходы') } });

    expect(report.axes.CATEGORICAL.themes[0]).toEqual({
      coordinate: 1n,
      text: 'Бюджет',
      confirmation: { kind: 'DIFFERS', onChain: 'Расходы' },
    });
  });

  it('reports an index entry the chain says is unset', async () => {
    const report = await reportOf(index, { themes: { 'CATEGORICAL:1': { kind: 'UNSET' } } });

    expect(report.axes.CATEGORICAL.themes[0].confirmation).toEqual({ kind: 'ABSENT_ON_CHAIN' });
  });

  it('keeps the projected text when the confirming read fails', async () => {
    // Degraded, not dropped: the event carried the label, so the best available
    // answer is still the voting's own wording plus an admission it is unconfirmed.
    const report = await reportOf(index, {});

    expect(report.axes.CATEGORICAL.themes[0]).toEqual({
      coordinate: 1n,
      text: 'Бюджет',
      confirmation: { kind: 'UNREAD' },
    });
  });
});

describe('a cell row', () => {
  const at = matrixCoordinate(3n, 7n);

  it('renders a categorical cell with its categories named per cell', async () => {
    const report = await reportOf(indexOf(categoryAdded(at, 2n)), {
      categorical: { '3,7': categoricalCell(ORGAN, [2n, 5n], 4n) },
      themes: { 'CATEGORICAL:3': axisLabel('Бюджет') },
      statements: { 'CATEGORICAL:7': axisLabel('Расходы') },
      categoryNames: { '3,7:2': axisLabel('ЗА'), '3,7:5': axisLabel('ПРОТИВ') },
      values: {
        'CATEGORICAL:3,7': {
          kind: 'SET',
          value: 2n,
          author: AUTHOR,
          recordedAt: unixSeconds(1_755_000_000),
        },
      },
    });

    expect(report.rows).toHaveLength(1);
    const [row] = report.rows;
    expect(row).toMatchObject({
      matrix: 'CATEGORICAL',
      at: { x: 3n, y: 7n },
      theme: { kind: 'SET', text: 'Бюджет' },
      statement: { kind: 'SET', text: 'Расходы' },
      organ: { kind: 'LABELLED', label: '74.СОВ' },
      sampleCount: 4n,
      unread: [],
    });
    expect(row.categories).toEqual([
      { category: 2n, name: { kind: 'SET', text: 'ЗА' } },
      { category: 5n, name: { kind: 'SET', text: 'ПРОТИВ' } },
    ]);
  });

  it('never scales a categorical value, because the number is a category', async () => {
    // `2` at two decimals would print as `0.02` and name a category nobody chose.
    const report = await reportOf(indexOf(categoryAdded(at, 2n)), {
      categorical: { '3,7': categoricalCell(ORGAN, [2n], 1n) },
      categoryNames: { '3,7:2': axisLabel('ЗА') },
      values: {
        'CATEGORICAL:3,7': {
          kind: 'SET',
          value: 2n,
          author: AUTHOR,
          recordedAt: unixSeconds(1_755_000_000),
        },
      },
    });

    expect(report.rows[0].value).toMatchObject({
      kind: 'SET',
      text: '2',
      raw: 2n,
      categoryName: { kind: 'SET', text: 'ЗА' },
    });
  });

  it('scales a numerical value by the cell’s own decimals, trailing zeros kept', async () => {
    const decimalsApplied: readonly MatrixIndexEvent[] = [
      {
        kind: 'DECIMALS_PROPOSED',
        votingId: 1n,
        organ: ORGAN,
        at,
        decimals: 2,
        position: position(10n),
      },
      { kind: 'VOTING_FINALIZED', votingId: 1n, success: true, position: position(100n) },
    ];

    const report = await reportOf(indexOf(...decimalsApplied), {
      numerical: { '3,7': numericalCell(ORGAN, 2, 1n) },
      values: {
        'NUMERICAL:3,7': {
          kind: 'SET',
          value: 150n,
          author: AUTHOR,
          recordedAt: unixSeconds(1_755_000_000),
        },
      },
    });

    // 1.50, not 1.5 — the trailing zero is the cell's precision, and trimming it
    // renders a value that no longer round-trips through a form.
    expect(report.rows[0].value).toMatchObject({ kind: 'SET', text: '1.50', raw: 150n });
    expect(report.rows[0].decimals).toBe(2);
  });

  it('reports a cell with no value yet as NONE rather than as zero', async () => {
    const report = await reportOf(indexOf(categoryAdded(at, 2n)), {
      categorical: { '3,7': categoricalCell(ORGAN, [], 0n) },
      themes: { 'CATEGORICAL:3': axisLabel('Бюджет') },
      statements: { 'CATEGORICAL:7': axisLabel('Расходы') },
      values: { 'CATEGORICAL:3,7': { kind: 'NONE' } },
    });

    expect(report.rows[0].value).toEqual({ kind: 'NONE' });
    // NONE is an answer, so the row is not degraded by it.
    expect(report.rows[0].unread).toEqual([]);
  });

  it('withholds decimals for an unbound cell, where zero is not a configured scale', async () => {
    // An untouched numerical cell reads `decimals` as 0, which is also a
    // legitimate configured scale — so a `0` printed for an unbound cell is a
    // claim the read cannot support.
    //
    // Reachable through a disagreement: the index attributed this coordinate
    // from a *finalized* decimals voting, and `setDecimals` binds the cell it
    // writes, so a cell reading UNBOUND here means the projection and the chain
    // do not agree.
    const decimalsApplied: readonly MatrixIndexEvent[] = [
      {
        kind: 'DECIMALS_PROPOSED',
        votingId: 1n,
        organ: ORGAN,
        at,
        decimals: 2,
        position: position(10n),
      },
      { kind: 'VOTING_FINALIZED', votingId: 1n, success: true, position: position(100n) },
    ];

    const bound = await reportOf(indexOf(...decimalsApplied), {
      numerical: { '3,7': numericalCell(ORGAN, 2) },
    });
    expect(bound.rows[0].decimals).toBe(2);

    const unbound = await reportOf(indexOf(...decimalsApplied), {
      numerical: { '3,7': numericalCell(undefined, 0) },
    });
    expect(unbound.rows[0].decimals).toBeUndefined();
    expect(unbound.rows[0].organ).toEqual({ kind: 'UNBOUND' });
  });
});

describe('an organ the reverse table cannot name', () => {
  it('prints the hash verbatim and keeps the row', async () => {
    // The table is a local enumeration bounded at local organ number 99, so an
    // organ outside it is real and simply unnameable here. Guessing would
    // attribute a cell to the wrong body; dropping the row would hide
    // coordinates a voter needs.
    const report = await reportOf(indexOf(categoryAdded(matrixCoordinate(1n, 1n), 1n)), {
      categorical: { '1,1': categoricalCell(UNLISTED_ORGAN, []) },
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].organ).toEqual({ kind: 'UNRESOLVED', organ: UNLISTED_ORGAN });
  });

  it('distinguishes an unbound cell from an unnameable organ', async () => {
    const report = await reportOf(indexOf(categoryAdded(matrixCoordinate(1n, 1n), 1n)), {
      categorical: { '1,1': categoricalCell(undefined, []) },
    });

    expect(report.rows[0].organ).toEqual({ kind: 'UNBOUND' });
  });
});

describe('a read that does not answer', () => {
  const at = matrixCoordinate(3n, 7n);

  it('keeps the row and names the field, so the coordinates survive', async () => {
    // The coordinates are the point of the document. A row silently dropped
    // would tell a voter the cell does not exist.
    const report = await reportOf(indexOf(categoryAdded(at, 2n)), {
      themes: { 'CATEGORICAL:3': axisLabel('Бюджет') },
    });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].at).toEqual({ x: 3n, y: 7n });
    expect(report.rows[0].unread).toEqual(['CELL', 'STATEMENT', 'VALUE']);
    expect(report.rows[0].organ).toEqual({ kind: 'UNREAD' });
    expect(report.degradedRows).toBe(1);
  });

  it('names an unread category name without discarding the number', async () => {
    const report = await reportOf(indexOf(categoryAdded(at, 2n)), {
      categorical: { '3,7': categoricalCell(ORGAN, [2n]) },
      themes: { 'CATEGORICAL:3': axisLabel('Бюджет') },
      statements: { 'CATEGORICAL:7': axisLabel('Расходы') },
      values: { 'CATEGORICAL:3,7': { kind: 'NONE' } },
    });

    expect(report.rows[0].categories).toEqual([{ category: 2n, name: undefined }]);
    expect(report.rows[0].unread).toEqual(['CATEGORY_NAME']);
  });

  it('fails the whole report when nothing at all was readable', async () => {
    // An outage printed as an empty matrix would tell a voter their party has no
    // matrix. There was work to do here and not one read answered.
    const outcome = await assembleMatrixReport({
      index: indexOf(categoryAdded(at, 2n), ...themeApplied('CATEGORICAL', 3n, 'Бюджет', 2n)),
      snapshot: snapshotOf({}),
      organs: organsKnowing(),
    });

    expect(outcome).toEqual({ kind: 'FAILED', reason: 'NOTHING_READABLE' });
  });

  it('still prints an axis inventory when every confirming read failed', async () => {
    // The inventory is event-derived — the creation events carry the label text
    // — so it is real content even during an outage. Withholding the party's own
    // themes over a network blip would help nobody, and there are no cell rows
    // here to be empty.
    const outcome = await assembleMatrixReport({
      index: indexOf(...themeApplied('CATEGORICAL', 3n, 'Бюджет')),
      snapshot: snapshotOf({}),
      organs: organsKnowing(),
    });

    expect(outcome.kind).toBe('REPORT');
  });

  it('still reports when one read out of many answered', async () => {
    // A tally rather than a flag: one success in a hundred is a degraded report,
    // not an outage.
    const outcome = await assembleMatrixReport({
      index: indexOf(categoryAdded(at, 2n)),
      snapshot: snapshotOf({ themes: { 'CATEGORICAL:3': axisLabel('Бюджет') } }),
      organs: organsKnowing(),
    });

    expect(outcome.kind).toBe('REPORT');
  });
});

describe('a coordinate ValueAdded named, which does not say which matrix', () => {
  const at = matrixCoordinate(3n, 7n);

  it('resolves to one matrix when only one cell is bound', async () => {
    const report = await reportOf(indexOf(valueAdded(at)), {
      categorical: { '3,7': categoricalCell(undefined, []) },
      numerical: { '3,7': numericalCell(ORGAN, 2) },
    });

    expect(report.rows.map((row) => row.matrix)).toEqual(['NUMERICAL']);
  });

  it('prints both rows when both cells are bound, rather than flipping a coin', async () => {
    // The two matrices are independent mappings over one coordinate space, so
    // (3, 7) can be bound in both and no read separates them.
    const report = await reportOf(indexOf(valueAdded(at)), {
      categorical: { '3,7': categoricalCell(ORGAN, [1n]) },
      numerical: { '3,7': numericalCell(ORGAN, 2) },
    });

    expect(report.rows.map((row) => row.matrix)).toEqual(['CATEGORICAL', 'NUMERICAL']);
  });

  it('prints both rows with the cell unread when the attribution could not be made', async () => {
    // The event named the coordinate, so it exists. Which matrix is unknown —
    // and the coordinate is what the voter needs. The theme read answers, so
    // this is a degraded report rather than the outage case.
    const report = await reportOf(indexOf(valueAdded(at)), {
      themes: { 'CATEGORICAL:3': axisLabel('Бюджет'), 'NUMERICAL:3': axisLabel('Бюджет') },
    });

    expect(report.rows.map((row) => row.matrix)).toEqual(['CATEGORICAL', 'NUMERICAL']);
    expect(report.rows.every((row) => row.unread.includes('CELL'))).toBe(true);
  });

  it('does not produce a duplicate row when a route already attributed it', async () => {
    const report = await reportOf(indexOf(valueAdded(at), categoryAdded(at, 1n)), {
      categorical: { '3,7': categoricalCell(ORGAN, [1n]) },
      numerical: { '3,7': numericalCell(ORGAN, 2) },
    });

    expect(report.rows.map((row) => row.matrix)).toEqual(['CATEGORICAL']);
  });
});

describe('reads are shared where the contract shares them', () => {
  it('reads a column’s theme once however many cells sit in it', async () => {
    // Themes are addressed by x and statements by y, so one read serves a whole
    // column. Sound only because the snapshot is pinned to a single block.
    const theme = vi.fn(async () => axisLabel('Бюджет'));
    const index = indexOf(
      categoryAdded(matrixCoordinate(3n, 1n), 1n),
      categoryAdded(matrixCoordinate(3n, 2n), 1n),
      categoryAdded(matrixCoordinate(3n, 3n), 1n),
    );

    const outcome = await assembleMatrixReport({
      index,
      snapshot: { ...snapshotOf({}), theme },
      organs: organsKnowing(),
    });

    expect(outcome.kind).toBe('REPORT');
    expect(theme).toHaveBeenCalledTimes(1);
  });
});

describe('row order', () => {
  it('groups by matrix and then ascends by x and y', async () => {
    const report = await reportOf(
      indexOf(
        categoryAdded(matrixCoordinate(10n, 1n), 1n),
        categoryAdded(matrixCoordinate(2n, 9n), 1n),
        categoryAdded(matrixCoordinate(2n, 3n), 1n),
        {
          kind: 'DECIMALS_PROPOSED',
          votingId: 5n,
          organ: ORGAN,
          at: matrixCoordinate(1n, 1n),
          decimals: 0,
          position: position(10n),
        },
        { kind: 'VOTING_FINALIZED', votingId: 5n, success: true, position: position(100n) },
      ),
      {
        categorical: {
          '10,1': categoricalCell(ORGAN, []),
          '2,9': categoricalCell(ORGAN, []),
          '2,3': categoricalCell(ORGAN, []),
        },
        numerical: { '1,1': numericalCell(ORGAN, 0) },
      },
    );

    expect(report.rows.map((row) => [row.matrix, row.at.x, row.at.y])).toEqual([
      ['CATEGORICAL', 2n, 3n],
      ['CATEGORICAL', 2n, 9n],
      ['CATEGORICAL', 10n, 1n],
      ['NUMERICAL', 1n, 1n],
    ]);
  });
});
