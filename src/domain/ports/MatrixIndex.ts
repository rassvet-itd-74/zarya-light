import type { MatrixIndexEvent } from '../matrix/matrixIndex';

/**
 * The event source the coordinate index is folded from.
 *
 * Scans a window and reports what is in it — it does not decide which window,
 * and it does not fold. Both of those are already owned elsewhere and for
 * reasons worth keeping: `planDiscovery` owns the window because every rule that
 * keeps a projection correct lives there, and `foldMatrixIndexWindow` owns the
 * fold because gating a proposal on its finalization is domain reasoning that
 * must be testable without a chain.
 *
 * Same shape as `VotingDiscovery` deliberately. The two are **projections over
 * one cursor's blocks**, not two independent sweeps (`CONTRACT.md`, "Enumerating
 * the matrix"), and `CursorKey.projection` is what keeps their positions apart
 * while the blocks stay shared.
 */
export interface ScannedIndexWindow {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /**
   * Every matrix-relevant log in the window, applied and proposed alike, plus
   * the finalizations that release the proposals.
   *
   * Unordered. The fold sorts by log position, because these arrive from
   * several filtered requests and arrival order says nothing about chain order.
   */
  readonly events: readonly MatrixIndexEvent[];
}

export interface MatrixIndex {
  /**
   * @throws {RangeError} on an inverted window, rather than quietly scanning
   * nothing — an empty result from a projection whose job is completeness is
   * indistinguishable from a quiet chain.
   */
  scan(fromBlock: bigint, toBlock: bigint): Promise<ScannedIndexWindow>;
}
