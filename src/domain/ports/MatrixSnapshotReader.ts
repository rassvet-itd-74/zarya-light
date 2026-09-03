import type {
  AxisLabel,
  CategoricalCell,
  MatrixCoordinate,
  MatrixKind,
  NumericalCell,
} from '../matrix/matrix';
import type { EvmAddress, UnixSeconds } from '../primitives';

/**
 * The report's reads, pinned to one block.
 *
 * A second matrix port beside `MatrixReader`, and the difference is the whole
 * reason it exists.
 *
 * **`MatrixReader` reads the head**, because preflight is asking what will
 * happen if a transaction is sent now, and pinning that to an older block would
 * predict against state the chain has already left behind.
 *
 * **This one reads one fixed block**, because a report is a *document*. Assembled
 * across the head, a theme could be read at block N and the value under it at
 * N + 2, so the page would show a pairing that never existed on chain — and
 * nothing on the page could reveal it. Pinning also makes the staleness stamp
 * true rather than approximate: the block named on every page is the block every
 * row was read at.
 *
 * The checkpoint readers `MatrixReader` deliberately omits live here, which is
 * the other half of the split — preflight reads no values, and the report reads
 * them for every cell.
 *
 * As everywhere in this client, **`undefined` means the read did not answer.**
 * An empty cell answers `UNBOUND`, an empty axis answers `UNSET`, and a cell with
 * no value yet answers `NONE`.
 */

/** The block a report was read at, and its chain timestamp. */
export interface ReadPoint {
  readonly blockNumber: bigint;
  /**
   * The block's own timestamp — chain time, never the workstation's.
   *
   * A report stamped with the reader's system clock would claim a freshness the
   * chain never asserted, which on a page a voter transcribes from is the
   * difference between "this is two minutes old" and "this is two months old".
   */
  readonly timestamp: UnixSeconds;
}

/**
 * The latest value in a cell's checkpoint history.
 *
 * `NONE` is a separate arm rather than a zero checkpoint because the contract
 * hands back a zero one: `getLatestCategoricalValue` returns
 * `{timestamp: 0, author: address(0), value: 0}` for an empty sample rather than
 * reverting (`Matricies.sol:334-349`). Left as-is that is indistinguishable from
 * a real value of `0` written by the zero address at the epoch — so the absence
 * is named here, and the adapter is the only place that has to know the sentinel.
 */
export type CellValue =
  | {
      readonly kind: 'SET';
      /** `uint64` as stored. Scaling by the cell's `decimals` is the renderer's job. */
      readonly value: bigint;
      readonly author: EvmAddress;
      readonly recordedAt: UnixSeconds;
    }
  | { readonly kind: 'NONE' };

export interface MatrixSnapshotReader {
  /** The block every read on this instance is pinned to. */
  readonly at: ReadPoint;

  categoricalCell(at: MatrixCoordinate): Promise<CategoricalCell | undefined>;

  numericalCell(at: MatrixCoordinate): Promise<NumericalCell | undefined>;

  theme(kind: MatrixKind, x: bigint): Promise<AxisLabel | undefined>;

  /** By `y` alone, as the contract addresses it. See `MatrixReader.statement`. */
  statement(kind: MatrixKind, y: bigint): Promise<AxisLabel | undefined>;

  /**
   * The name beside a category number, per cell.
   *
   * Per cell rather than global: `getCategoryName(x, y, category)` is addressed
   * by coordinate, so category `2` may be named differently in two cells and a
   * report that cached one name across the matrix would print the wrong one.
   */
  categoryName(at: MatrixCoordinate, category: bigint): Promise<AxisLabel | undefined>;

  latestValue(kind: MatrixKind, at: MatrixCoordinate): Promise<CellValue | undefined>;
}
