import type { Bytes32, EvmAddress } from '../primitives';
import { type MatrixCoordinate, type MatrixKind, MATRIX_KINDS, coordinateKey } from './matrix';

/**
 * Which coordinates exist, projected from the event stream.
 *
 * The contract **cannot be asked what the matrix contains** — there is no
 * dimension getter and no cell enumeration, and every read is `(x, y)`-addressed,
 * so a coordinate has to be known before it can be read (`CONTRACT.md`, "Not
 * exposed"). What makes a projection sufficient rather than a guess is that
 * matrix state changes *only* through a successful voting, and every such change
 * is observable. So the event stream is a complete index, not a sample.
 *
 * ## Two routes, and the second one is gated
 *
 * **Applied changes** — `ValueAdded` and `CategoryAdded` — fire from inside
 * `_executeApprovedSuggestion`, so their presence *is* the evidence that a voting
 * passed and its mutation landed. They need no gating.
 *
 * **Everything else** emits nothing on application. `Matricies.setDecimals`,
 * `setTheme` and `setStatement` are silent, so a decimals, theme or statement
 * change is observable only as a *creation* event joined to
 * `VotingFinalized(success = true)` for the same `votingId`. Ungated, the index
 * would list coordinates and axis labels that were merely **proposed** — and a
 * voter transcribing one would fill in a form that fails preflight for a cell
 * that never existed.
 *
 * ## Application order is finalization order, not creation order
 *
 * This is the rule that is easy to get backwards. A theme proposed in block 10
 * and executed in block 900 overwrites one proposed in block 20 and executed in
 * block 500 — because `setTheme` runs inside `executeVoting`, not inside
 * `createThemeVoting`. So a "last one wins" fold has to be ordered by the
 * **finalization** log's position, and this module keeps unmatched proposals
 * across windows precisely so that a creation and its finalization can be
 * thousands of blocks apart.
 *
 * ## What this module deliberately does not decide
 *
 * `ValueAdded` carries no `isCategorical` (`Matricies.sol:45`), so a coordinate
 * learned that way is recorded as **unattributed** and stays that way here. Which
 * matrix it belongs to is decided by reading the cells at those coordinates and
 * applying `attributeValue` — a chain read, and not this fold's business. The
 * other two routes need no inference: a category can only exist in the
 * categorical matrix, and `decimals` only in the numerical one.
 */

/**
 * Where a log sat, to a total order.
 *
 * `logIndex` is not decoration. Two theme votings executed in the same block
 * resolve to whichever transaction ran second, and block number alone cannot
 * say which that was — so an index ordered by block would pick one of the two
 * arbitrarily and be right half the time.
 */
export interface LogPosition {
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export const beforePosition = (a: LogPosition, b: LogPosition): boolean =>
  a.blockNumber === b.blockNumber ? a.logIndex < b.logIndex : a.blockNumber < b.blockNumber;

/** An applied change, or a proposal awaiting its verdict, or that verdict. */
export type MatrixIndexEvent =
  /** Applied. A value landed, but the log does not say in which matrix. */
  | {
      readonly kind: 'VALUE_ADDED';
      readonly at: MatrixCoordinate;
      readonly value: bigint;
      readonly author: EvmAddress;
      readonly position: LogPosition;
    }
  /** Applied, and self-attributing: categories exist only in the categorical matrix. */
  | {
      readonly kind: 'CATEGORY_ADDED';
      readonly at: MatrixCoordinate;
      readonly category: bigint;
      readonly position: LogPosition;
    }
  /** Proposed. Gated on finalization — `setDecimals` emits nothing of its own. */
  | {
      readonly kind: 'DECIMALS_PROPOSED';
      readonly votingId: bigint;
      readonly organ: Bytes32;
      readonly at: MatrixCoordinate;
      readonly decimals: number;
      readonly position: LogPosition;
    }
  | {
      readonly kind: 'THEME_PROPOSED';
      readonly votingId: bigint;
      readonly matrix: MatrixKind;
      readonly x: bigint;
      readonly text: string;
      readonly position: LogPosition;
    }
  /**
   * Proposed.
   *
   * The event carries an `x` as well as a `y`, and it is dropped here on purpose:
   * `setStatement(isCategorical, x, y, …)` uses `x` only to require a theme
   * there, then writes `statements[isCategorical][y]`
   * (`Matricies.sol:168-181`). Keeping the `x` would suggest an addressing the
   * contract does not have, and would split one statement row into several.
   */
  | {
      readonly kind: 'STATEMENT_PROPOSED';
      readonly votingId: bigint;
      readonly matrix: MatrixKind;
      readonly y: bigint;
      readonly text: string;
      readonly position: LogPosition;
    }
  /** The verdict that releases a gated proposal — or discards it. */
  | {
      readonly kind: 'VOTING_FINALIZED';
      readonly votingId: bigint;
      readonly success: boolean;
      readonly position: LogPosition;
    };

/** The gated half of {@link MatrixIndexEvent}, held until its verdict arrives. */
export type GatedProposal = Extract<
  MatrixIndexEvent,
  { kind: 'DECIMALS_PROPOSED' | 'THEME_PROPOSED' | 'STATEMENT_PROPOSED' }
>;

/**
 * A theme or statement as the index knows it.
 *
 * `text` comes from the creation event, which carries the label itself, so the
 * axis inventory needs no chain read to be *populated*. A read still confirms it
 * — see `MatrixSnapshotReader` — because this text is what the winning voting
 * asked for, and confirming costs one call.
 */
export interface AxisEntry {
  /** `x` for a theme, `y` for a statement. */
  readonly coordinate: bigint;
  readonly text: string;
  /** The block the winning voting was executed in, not the one it was created in. */
  readonly appliedAt: LogPosition;
  readonly votingId: bigint;
}

/** Coordinates grouped by what the index can already say about them. */
export interface IndexedCoordinates {
  /** From `CategoryAdded`. Definitely in the categorical matrix. */
  readonly categorical: readonly MatrixCoordinate[];
  /** From a finalized decimals voting. Definitely in the numerical matrix. */
  readonly numerical: readonly MatrixCoordinate[];
  /**
   * From `ValueAdded`, which does not say which matrix.
   *
   * Not a defect in this fold — the information is not in the log. The report
   * resolves each of these by reading both cells, and a coordinate bound in both
   * matrices is `AMBIGUOUS` rather than guessed at.
   */
  readonly unattributed: readonly MatrixCoordinate[];
}

export interface CoordinateIndex {
  readonly coordinates: IndexedCoordinates;
  /** Themes by matrix, ascending by `x`. */
  readonly themes: { readonly [K in MatrixKind]: readonly AxisEntry[] };
  /** Statements by matrix, ascending by `y`. */
  readonly statements: { readonly [K in MatrixKind]: readonly AxisEntry[] };
}

/**
 * The fold's carry.
 *
 * `awaiting` is the reason this is a state rather than a one-shot function. A
 * proposal and its finalization are separated by the voting's whole duration —
 * hours or days, which at Sepolia's block time is far more than one scan window
 * — so a fold that forgot unmatched proposals at a window boundary would miss
 * every theme whose voting straddled one.
 */
export interface MatrixIndexState {
  readonly index: CoordinateIndex;
  readonly awaiting: ReadonlyMap<bigint, GatedProposal>;
}

const emptyByKind = <T>(make: () => T): { [K in MatrixKind]: T } =>
  Object.fromEntries(MATRIX_KINDS.map((kind) => [kind, make()])) as { [K in MatrixKind]: T };

export const emptyMatrixIndexState = (): MatrixIndexState => ({
  index: {
    coordinates: { categorical: [], numerical: [], unattributed: [] },
    themes: emptyByKind<readonly AxisEntry[]>(() => []),
    statements: emptyByKind<readonly AxisEntry[]>(() => []),
  },
  awaiting: new Map(),
});

/** Whether the index has nothing at all — a normal state for a young matrix. */
export const isEmptyIndex = (index: CoordinateIndex): boolean =>
  index.coordinates.categorical.length === 0 &&
  index.coordinates.numerical.length === 0 &&
  index.coordinates.unattributed.length === 0 &&
  MATRIX_KINDS.every(
    (kind) => index.themes[kind].length === 0 && index.statements[kind].length === 0,
  );

/** Mutable working copy, so one window is folded without copying per event. */
interface Working {
  readonly categorical: Map<string, MatrixCoordinate>;
  readonly numerical: Map<string, MatrixCoordinate>;
  readonly unattributed: Map<string, MatrixCoordinate>;
  readonly themes: { [K in MatrixKind]: Map<string, AxisEntry> };
  readonly statements: { [K in MatrixKind]: Map<string, AxisEntry> };
  readonly awaiting: Map<bigint, GatedProposal>;
}

const toWorking = (state: MatrixIndexState): Working => ({
  categorical: byCoordinate(state.index.coordinates.categorical),
  numerical: byCoordinate(state.index.coordinates.numerical),
  unattributed: byCoordinate(state.index.coordinates.unattributed),
  themes: emptyByKind(() => new Map<string, AxisEntry>()),
  statements: emptyByKind(() => new Map<string, AxisEntry>()),
  awaiting: new Map(state.awaiting),
});

const byCoordinate = (list: readonly MatrixCoordinate[]): Map<string, MatrixCoordinate> =>
  new Map(list.map((at) => [coordinateKey(at), at]));

/**
 * Folds one scanned window into the index.
 *
 * Total on its input: an event this fold does not recognise as belonging to a
 * matrix change is ignored rather than rejected, because the same log stream
 * carries votings of every other type and a membership voting's finalization is
 * not an anomaly.
 *
 * **Re-folding a window is safe.** Applied coordinates are a set, and an axis
 * entry is replaced by the one with the later position — so a window scanned
 * twice after a crash produces the same index, which is what lets the cursor
 * advance only after a window is handled.
 */
export function foldMatrixIndexWindow(
  state: MatrixIndexState,
  events: readonly MatrixIndexEvent[],
): MatrixIndexState {
  const working = toWorking(state);
  for (const kind of MATRIX_KINDS) {
    for (const entry of state.index.themes[kind]) {
      working.themes[kind].set(entry.coordinate.toString(), entry);
    }
    for (const entry of state.index.statements[kind]) {
      working.statements[kind].set(entry.coordinate.toString(), entry);
    }
  }

  // Sorted rather than trusted: `eth_getLogs` responses are merged from two
  // filtered requests here, so arrival order says nothing about chain order,
  // and chain order is what decides which of two themes at one `x` survives.
  for (const event of [...events].sort((a, b) => comparePositions(a.position, b.position))) {
    switch (event.kind) {
      case 'VALUE_ADDED':
        // Only if no route has already attributed it. A cell that got its
        // categories first is known to be categorical, and demoting it to
        // unattributed would send the report off to re-derive what it knows.
        if (!isAttributed(working, event.at)) {
          working.unattributed.set(coordinateKey(event.at), event.at);
        }
        break;

      case 'CATEGORY_ADDED':
        working.categorical.set(coordinateKey(event.at), event.at);
        working.unattributed.delete(coordinateKey(event.at));
        break;

      case 'DECIMALS_PROPOSED':
      case 'THEME_PROPOSED':
      case 'STATEMENT_PROPOSED':
        working.awaiting.set(event.votingId, event);
        break;

      case 'VOTING_FINALIZED': {
        const proposal = working.awaiting.get(event.votingId);
        // Unknown ids are the common case: every membership, category and value
        // voting finalizes here too, and none of them is gated.
        if (proposal === undefined) break;
        working.awaiting.delete(event.votingId);
        // A rejected voting leaves nothing behind. Recording it "for
        // completeness" would put a coordinate in a voter's hands that no read
        // can resolve and no form can use.
        if (event.success) applyProposal(working, proposal, event.position);
        break;
      }
    }
  }

  return {
    index: {
      coordinates: {
        categorical: sortedCoordinates(working.categorical),
        numerical: sortedCoordinates(working.numerical),
        unattributed: sortedCoordinates(working.unattributed),
      },
      themes: axisLists(working.themes),
      statements: axisLists(working.statements),
    },
    awaiting: working.awaiting,
  };
}

const axisLists = (from: {
  [K in MatrixKind]: Map<string, AxisEntry>;
}): { readonly [K in MatrixKind]: readonly AxisEntry[] } =>
  Object.fromEntries(MATRIX_KINDS.map((kind) => [kind, sortedEntries(from[kind])])) as {
    readonly [K in MatrixKind]: readonly AxisEntry[];
  };

const isAttributed = (working: Working, at: MatrixCoordinate): boolean => {
  const key = coordinateKey(at);
  return working.categorical.has(key) || working.numerical.has(key);
};

function applyProposal(
  working: Working,
  proposal: GatedProposal,
  appliedAt: LogPosition,
): void {
  switch (proposal.kind) {
    case 'DECIMALS_PROPOSED': {
      const key = coordinateKey(proposal.at);
      working.numerical.set(key, proposal.at);
      working.unattributed.delete(key);
      break;
    }
    case 'THEME_PROPOSED':
      replaceIfLater(working.themes[proposal.matrix], {
        coordinate: proposal.x,
        text: proposal.text,
        appliedAt,
        votingId: proposal.votingId,
      });
      break;
    case 'STATEMENT_PROPOSED':
      replaceIfLater(working.statements[proposal.matrix], {
        coordinate: proposal.y,
        text: proposal.text,
        appliedAt,
        votingId: proposal.votingId,
      });
      break;
  }
}

/**
 * Keeps the later application, so re-folding a window cannot move an axis label
 * backwards to a superseded one.
 */
const replaceIfLater = (into: Map<string, AxisEntry>, entry: AxisEntry): void => {
  const key = entry.coordinate.toString();
  const existing = into.get(key);
  if (existing === undefined || !beforePosition(entry.appliedAt, existing.appliedAt)) {
    into.set(key, entry);
  }
};

const comparePositions = (a: LogPosition, b: LogPosition): number =>
  a.blockNumber === b.blockNumber
    ? a.logIndex - b.logIndex
    : a.blockNumber < b.blockNumber
      ? -1
      : 1;

/** Ascending by `x` then `y`, so a printed page reads like a table. */
const sortedCoordinates = (from: Map<string, MatrixCoordinate>): readonly MatrixCoordinate[] =>
  [...from.values()].sort((a, b) =>
    a.x === b.x ? compareBigints(a.y, b.y) : compareBigints(a.x, b.x),
  );

const sortedEntries = (from: Map<string, AxisEntry>): readonly AxisEntry[] =>
  [...from.values()].sort((a, b) => compareBigints(a.coordinate, b.coordinate));

const compareBigints = (a: bigint, b: bigint): number => (a === b ? 0 : a < b ? -1 : 1);

/**
 * Coordinates whose matrix is still unknown, as a reason to read.
 *
 * Exposed separately because it is the report's work list for `attributeValue`:
 * one pair of cell reads each, and no other coordinate needs them.
 */
export const unattributedCoordinates = (index: CoordinateIndex): readonly MatrixCoordinate[] =>
  index.coordinates.unattributed;

/**
 * Every coordinate the index knows to be in `matrix`.
 *
 * Attribution of the `ValueAdded` half happens outside; this returns only what
 * the events themselves establish.
 */
export const attributedCoordinates = (
  index: CoordinateIndex,
  matrix: MatrixKind,
): readonly MatrixCoordinate[] =>
  matrix === 'CATEGORICAL' ? index.coordinates.categorical : index.coordinates.numerical;
