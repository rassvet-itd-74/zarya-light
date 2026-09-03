import { describe, expect, it } from 'vitest';
import { bytes32, evmAddress } from '../primitives';
import { matrixCoordinate } from './matrix';
import {
  type MatrixIndexEvent,
  type MatrixIndexState,
  emptyMatrixIndexState,
  foldMatrixIndexWindow,
  isEmptyIndex,
} from './matrixIndex';

/**
 * The projection is the only thing standing between a voter and a coordinate
 * that does not exist, so most of these tests are about what must **not** appear
 * in it.
 */

const ORGAN = bytes32(`0x${'11'.repeat(32)}`);
const AUTHOR = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');

const at = (block: bigint, logIndex = 0) => ({ blockNumber: block, logIndex });

const themeProposed = (
  votingId: bigint,
  x: bigint,
  text: string,
  position: { blockNumber: bigint; logIndex: number },
): MatrixIndexEvent => ({
  kind: 'THEME_PROPOSED',
  votingId,
  matrix: 'NUMERICAL',
  x,
  text,
  position,
});

const finalized = (
  votingId: bigint,
  success: boolean,
  position: { blockNumber: bigint; logIndex: number },
): MatrixIndexEvent => ({ kind: 'VOTING_FINALIZED', votingId, success, position });

const fold = (...windows: readonly MatrixIndexEvent[][]): MatrixIndexState =>
  windows.reduce(foldMatrixIndexWindow, emptyMatrixIndexState());

describe('an empty index', () => {
  it('is a state, not an error — a young matrix has axes before it has cells', () => {
    expect(isEmptyIndex(emptyMatrixIndexState().index)).toBe(true);
  });

  it('stops being empty as soon as one axis label lands', () => {
    const state = fold([themeProposed(1n, 0n, 'Бюджет', at(10n)), finalized(1n, true, at(20n))]);
    expect(isEmptyIndex(state.index)).toBe(false);
  });
});

describe('the gate on finalization', () => {
  it('publishes a theme only once its voting succeeded', () => {
    const state = fold([themeProposed(1n, 3n, 'Бюджет', at(10n)), finalized(1n, true, at(20n))]);

    expect(state.index.themes.NUMERICAL).toEqual([
      { coordinate: 3n, text: 'Бюджет', appliedAt: at(20n), votingId: 1n },
    ]);
  });

  it('publishes nothing while the voting is still open', () => {
    // The whole point of the gate. `setTheme` emits nothing, so a creation event
    // alone is a proposal — and a voter who transcribed it would fill in a form
    // against an axis that does not exist.
    const state = fold([themeProposed(1n, 3n, 'Бюджет', at(10n))]);

    expect(state.index.themes.NUMERICAL).toEqual([]);
    expect(state.awaiting.has(1n)).toBe(true);
  });

  it('discards a rejected proposal rather than recording it for completeness', () => {
    const state = fold([themeProposed(1n, 3n, 'Бюджет', at(10n)), finalized(1n, false, at(20n))]);

    expect(state.index.themes.NUMERICAL).toEqual([]);
    expect(state.awaiting.has(1n)).toBe(false);
  });

  it('carries an unmatched proposal across windows, because a voting outlives one', () => {
    // A voting runs for hours or days; a scan window is 5 000 blocks. A fold that
    // dropped unmatched proposals at the boundary would lose every theme whose
    // voting straddled one, which is nearly all of them.
    const state = fold(
      [themeProposed(1n, 3n, 'Бюджет', at(10n))],
      [],
      [finalized(1n, true, at(9_000n))],
    );

    expect(state.index.themes.NUMERICAL).toEqual([
      { coordinate: 3n, text: 'Бюджет', appliedAt: at(9_000n), votingId: 1n },
    ]);
  });

  it('ignores a finalization for a voting it never saw proposed', () => {
    // Every membership, category and value voting finalizes on this same stream
    // and none of them is gated, so an unknown id is the common case.
    const state = fold([finalized(99n, true, at(20n))]);

    expect(isEmptyIndex(state.index)).toBe(true);
  });
});

describe('application order is finalization order', () => {
  it('lets the later-executed voting win even though it was proposed first', () => {
    // The rule that is easy to get backwards. `setTheme` runs inside
    // `executeVoting`, so voting 1 — created first, executed last — is the one
    // whose text survives.
    const state = fold([
      themeProposed(1n, 3n, 'proposed first, executed last', at(10n)),
      themeProposed(2n, 3n, 'Proposed second, executed first', at(20n)),
      finalized(2n, true, at(500n)),
      finalized(1n, true, at(900n)),
    ]);

    expect(state.index.themes.NUMERICAL).toEqual([
      {
        coordinate: 3n,
        text: 'proposed first, executed last',
        appliedAt: at(900n),
        votingId: 1n,
      },
    ]);
  });

  it('separates two executions in one block by log index', () => {
    // Block number alone cannot say which transaction ran second, so an index
    // ordered by block would pick one of the two arbitrarily.
    const state = fold([
      themeProposed(1n, 3n, 'first in the block', at(10n)),
      themeProposed(2n, 3n, 'second in the block', at(11n)),
      finalized(1n, true, at(500n, 4)),
      finalized(2n, true, at(500n, 9)),
    ]);

    expect(state.index.themes.NUMERICAL[0].text).toBe('second in the block');
  });

  it('does not depend on the order the logs arrived in', () => {
    // Two filtered getLogs requests are merged here, so arrival order says
    // nothing about chain order.
    const events = [
      finalized(1n, true, at(900n)),
      themeProposed(2n, 3n, 'executed first', at(20n)),
      finalized(2n, true, at(500n)),
      themeProposed(1n, 3n, 'executed last', at(10n)),
    ];

    expect(fold(events).index.themes.NUMERICAL[0].text).toBe('executed last');
  });
});

describe('what each route establishes about a coordinate', () => {
  it('treats a ValueAdded coordinate as unattributed, because the log does not say', () => {
    const state = fold([
      {
        kind: 'VALUE_ADDED',
        at: matrixCoordinate(3n, 7n),
        value: 42n,
        author: AUTHOR,
        position: at(10n),
      },
    ]);

    expect(state.index.coordinates.unattributed).toEqual([{ x: 3n, y: 7n }]);
    expect(state.index.coordinates.categorical).toEqual([]);
    expect(state.index.coordinates.numerical).toEqual([]);
  });

  it('attributes a CategoryAdded coordinate to the categorical matrix with no read', () => {
    // Categories exist only there, so this route is self-attributing.
    const state = fold([
      { kind: 'CATEGORY_ADDED', at: matrixCoordinate(3n, 7n), category: 2n, position: at(10n) },
    ]);

    expect(state.index.coordinates.categorical).toEqual([{ x: 3n, y: 7n }]);
    expect(state.index.coordinates.unattributed).toEqual([]);
  });

  it('promotes a coordinate out of unattributed once a route names its matrix', () => {
    // Otherwise the report spends a pair of cell reads re-deriving what the
    // events already established.
    const state = fold(
      [
        {
          kind: 'VALUE_ADDED',
          at: matrixCoordinate(3n, 7n),
          value: 42n,
          author: AUTHOR,
          position: at(10n),
        },
      ],
      [{ kind: 'CATEGORY_ADDED', at: matrixCoordinate(3n, 7n), category: 2n, position: at(11n) }],
    );

    expect(state.index.coordinates.categorical).toEqual([{ x: 3n, y: 7n }]);
    expect(state.index.coordinates.unattributed).toEqual([]);
  });

  it('does not demote an attributed coordinate when a later value lands on it', () => {
    const state = fold([
      { kind: 'CATEGORY_ADDED', at: matrixCoordinate(3n, 7n), category: 2n, position: at(10n) },
      {
        kind: 'VALUE_ADDED',
        at: matrixCoordinate(3n, 7n),
        value: 2n,
        author: AUTHOR,
        position: at(11n),
      },
    ]);

    expect(state.index.coordinates.categorical).toEqual([{ x: 3n, y: 7n }]);
    expect(state.index.coordinates.unattributed).toEqual([]);
  });

  it('attributes a finalized decimals voting to the numerical matrix', () => {
    const state = fold([
      {
        kind: 'DECIMALS_PROPOSED',
        votingId: 1n,
        organ: ORGAN,
        at: matrixCoordinate(4n, 9n),
        decimals: 2,
        position: at(10n),
      },
      finalized(1n, true, at(20n)),
    ]);

    expect(state.index.coordinates.numerical).toEqual([{ x: 4n, y: 9n }]);
  });

  it('records nothing for a decimals voting that failed', () => {
    const state = fold([
      {
        kind: 'DECIMALS_PROPOSED',
        votingId: 1n,
        organ: ORGAN,
        at: matrixCoordinate(4n, 9n),
        decimals: 2,
        position: at(10n),
      },
      finalized(1n, false, at(20n)),
    ]);

    expect(state.index.coordinates.numerical).toEqual([]);
  });
});

describe('statements are addressed by y alone', () => {
  it('collapses two statement votings at different x and the same y into one entry', () => {
    // `setStatement` uses `x` only to require a theme there, then writes
    // `statements[isCategorical][y]`. Keeping the `x` would split one row into
    // two and suggest an addressing the contract does not have.
    const state = fold([
      {
        kind: 'STATEMENT_PROPOSED',
        votingId: 1n,
        matrix: 'CATEGORICAL',
        y: 5n,
        text: 'first',
        position: at(10n),
      },
      {
        kind: 'STATEMENT_PROPOSED',
        votingId: 2n,
        matrix: 'CATEGORICAL',
        y: 5n,
        text: 'second',
        position: at(11n),
      },
      finalized(1n, true, at(100n)),
      finalized(2n, true, at(200n)),
    ]);

    expect(state.index.statements.CATEGORICAL).toEqual([
      { coordinate: 5n, text: 'second', appliedAt: at(200n), votingId: 2n },
    ]);
  });
});

describe('the two matrices are separate spaces', () => {
  it('keeps a theme at x=3 in each without either overwriting the other', () => {
    const state = fold([
      { kind: 'THEME_PROPOSED', votingId: 1n, matrix: 'CATEGORICAL', x: 3n, text: 'кат', position: at(10n) },
      { kind: 'THEME_PROPOSED', votingId: 2n, matrix: 'NUMERICAL', x: 3n, text: 'чис', position: at(11n) },
      finalized(1n, true, at(100n)),
      finalized(2n, true, at(101n)),
    ]);

    expect(state.index.themes.CATEGORICAL).toEqual([
      { coordinate: 3n, text: 'кат', appliedAt: at(100n), votingId: 1n },
    ]);
    expect(state.index.themes.NUMERICAL).toEqual([
      { coordinate: 3n, text: 'чис', appliedAt: at(101n), votingId: 2n },
    ]);
  });
});

describe('re-folding a window', () => {
  const window: readonly MatrixIndexEvent[] = [
    { kind: 'CATEGORY_ADDED', at: matrixCoordinate(3n, 7n), category: 2n, position: at(10n) },
    themeProposed(1n, 3n, 'Бюджет', at(11n)),
    finalized(1n, true, at(12n)),
  ];

  it('produces the same index, which is what lets the cursor advance after the fact', () => {
    // The cursor commits only once a window is handled, so a crash mid-window
    // re-scans. That is safe only if re-folding is idempotent.
    const once = fold([...window]);
    const twice = foldMatrixIndexWindow(once, [...window]);

    expect(twice.index).toEqual(once.index);
  });

  it('does not move an axis label back to a superseded one', () => {
    const state = fold(
      [themeProposed(1n, 3n, 'старое', at(10n)), finalized(1n, true, at(100n))],
      [themeProposed(2n, 3n, 'новое', at(20n)), finalized(2n, true, at(200n))],
    );

    // Replaying the first window must not resurrect its text.
    const replayed = foldMatrixIndexWindow(state, [
      themeProposed(1n, 3n, 'старое', at(10n)),
      finalized(1n, true, at(100n)),
    ]);

    expect(replayed.index.themes.NUMERICAL[0].text).toBe('новое');
  });
});

describe('ordering for the printed page', () => {
  it('sorts coordinates by x then y', () => {
    const state = fold(
      [10n, 2n, 1n].flatMap((x): MatrixIndexEvent[] =>
        [20n, 3n].map((y) => ({
          kind: 'CATEGORY_ADDED',
          at: matrixCoordinate(x, y),
          category: 1n,
          position: at(10n),
        })),
      ),
    );

    expect(state.index.coordinates.categorical).toEqual([
      { x: 1n, y: 3n },
      { x: 1n, y: 20n },
      { x: 2n, y: 3n },
      { x: 2n, y: 20n },
      { x: 10n, y: 3n },
      { x: 10n, y: 20n },
    ]);
  });

  it('sorts axis entries numerically, not as strings', () => {
    // `10` before `9` is what a string sort would give, and a printed reference
    // whose rows are out of order is one a voter reads the wrong row from.
    const state = fold(
      [2n, 10n, 9n].flatMap((x, index): MatrixIndexEvent[] => [
        themeProposed(BigInt(index + 1), x, `тема ${x}`, at(10n)),
        finalized(BigInt(index + 1), true, at(100n + BigInt(index))),
      ]),
    );

    expect(state.index.themes.NUMERICAL.map((entry) => entry.coordinate)).toEqual([2n, 9n, 10n]);
  });
});
