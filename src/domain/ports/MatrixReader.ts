import type {
  AxisLabel,
  CategoricalCell,
  MatrixCoordinate,
  MatrixKind,
  NumericalCell,
} from '../matrix/matrix';

/**
 * The matrix metadata reads preflight depends on.
 *
 * Narrower than the contract's matrix surface on purpose. The checkpoint
 * readers — `get*LatestValue`, `get*ValueAt`, `get*History` — belong to the
 * matrix report (Phase 4) and are not here, because nothing in preflight or
 * discovery reads a value. What *is* here is exactly the state that decides
 * whether a proposal will still be applicable when it is executed.
 *
 * Same rule as every other reader in this client: **`undefined` means the read
 * did not answer.** It never means "empty cell" — an empty cell is an `UNBOUND`
 * binding and an `UNSET` label, both of which are answers.
 */
export interface MatrixReader {
  categoricalCell(at: MatrixCoordinate): Promise<CategoricalCell | undefined>;

  numericalCell(at: MatrixCoordinate): Promise<NumericalCell | undefined>;

  /** The theme at column `x`. Required before any value or statement lands there. */
  theme(kind: MatrixKind, x: bigint): Promise<AxisLabel | undefined>;

  /**
   * The statement at row `y` — **`y` alone**, which is not a simplification of
   * the contract but a faithful copy of it. `setStatement(isCategorical, x, y,
   * …)` validates a theme at `x` and then writes `statements[isCategorical][y]`
   * (`Matricies.sol:168-181`), and `getStatement` reads by `y` only. The `x` is a
   * gate, not part of the address, so a later statement voting at a different
   * `x` and the same `y` overwrites this one. A port taking `x` here would
   * suggest an addressing that does not exist.
   */
  statement(kind: MatrixKind, y: bigint): Promise<AxisLabel | undefined>;
}
