import type {
  AxisLabel,
  CategoricalCell,
  MatrixCoordinate,
  MatrixKind,
  NumericalCell,
} from '../../domain/matrix/matrix';
import type {
  CellValue,
  MatrixSnapshotReader,
  ReadPoint,
} from '../../domain/ports/MatrixSnapshotReader';
import { type EvmAddress, evmAddress, unixSeconds } from '../../domain/primitives';
import { DEFAULT_CONFIRMATIONS } from '../../domain/voting/discoveryPlan';
import { callContract } from './contractCall';
import { ZaryaMatrixReader, isCategoricalOf } from './matrixReader';
import type { ZaryaPublicClient } from './publicClient';

/**
 * Every matrix read a report needs, pinned to one block.
 *
 * Composes `ZaryaMatrixReader` rather than repeating it: cells and axis labels
 * decode identically whether they are read at the head or at a pin, and two
 * copies of that decoding would be two versions of one rule with only one of
 * them under the fork tests. What this adds is the half `MatrixReader`
 * deliberately excludes — the checkpoint values and the per-cell category names,
 * which preflight never reads and a report reads for every row.
 *
 * ## Why the pin is the *confirmed* head rather than the index cursor
 *
 * Two constraints pull in opposite directions and this is where they meet.
 *
 * Pinning to the index cursor would make the document perfectly
 * self-consistent — the same block that produced the coordinate list would
 * produce every value. But a cursor mid-backfill can be millions of blocks back,
 * and reading *state* there needs an archive node, which a public Sepolia
 * endpoint is not. The report would fail exactly when it was most needed.
 *
 * So the pin is `head - confirmations`: recent enough that any node still holds
 * the state, and behind the head by the same depth discovery uses, so a reorg
 * cannot take the block out from under a document someone is printing. When the
 * index cursor is *behind* that block the report is not wrong, it is incomplete
 * in one direction only — a cell created in between is missing rather than
 * misdescribed — and the report model reports that gap rather than hiding it.
 */
export class ZaryaMatrixSnapshot implements MatrixSnapshotReader {
  private readonly cells: ZaryaMatrixReader;

  constructor(
    private readonly client: ZaryaPublicClient,
    private readonly address: EvmAddress,
    readonly at: ReadPoint,
  ) {
    this.cells = new ZaryaMatrixReader(client, address, at.blockNumber);
  }

  /**
   * Reads the block to pin to, and returns `undefined` if it cannot.
   *
   * `undefined` rather than a throw, and rather than falling back to the
   * workstation clock: a report with no block stamp is not a stale report, it is
   * no report, and the one thing it must never do is claim a freshness the chain
   * did not assert.
   */
  static async atConfirmedHead(
    client: ZaryaPublicClient,
    address: EvmAddress,
    confirmations: bigint = DEFAULT_CONFIRMATIONS,
  ): Promise<ZaryaMatrixSnapshot | undefined> {
    try {
      const head = await client.getBlockNumber();
      // Saturating, as `planDiscovery` does: a fresh devnet can have a head
      // below the confirmation depth, and there is no negative block.
      const target = head >= confirmations ? head - confirmations : 0n;
      const block = await client.getBlock({ blockNumber: target });
      return new ZaryaMatrixSnapshot(client, address, {
        blockNumber: block.number ?? target,
        timestamp: unixSeconds(Number(block.timestamp)),
      });
    } catch {
      return undefined;
    }
  }

  categoricalCell(at: MatrixCoordinate): Promise<CategoricalCell | undefined> {
    return this.cells.categoricalCell(at);
  }

  numericalCell(at: MatrixCoordinate): Promise<NumericalCell | undefined> {
    return this.cells.numericalCell(at);
  }

  theme(kind: MatrixKind, x: bigint): Promise<AxisLabel | undefined> {
    return this.cells.theme(kind, x);
  }

  statement(kind: MatrixKind, y: bigint): Promise<AxisLabel | undefined> {
    return this.cells.statement(kind, y);
  }

  /**
   * Addressed by coordinate, because the contract addresses it that way:
   * `getCategoryName(x, y, category)`. Category `2` can be named differently in
   * two cells, so a report that cached one name matrix-wide would print the
   * wrong one under the right number.
   */
  categoryName(at: MatrixCoordinate, category: bigint): Promise<AxisLabel | undefined> {
    return this.cells.readLabel('getCategoryName', [at.x, at.y, category]);
  }

  /**
   * The latest checkpoint, with the contract's empty-sample sentinel translated.
   *
   * `getLatestCategoricalValue` returns `{timestamp: 0, author: address(0),
   * value: 0}` for a cell nothing has been written to, rather than reverting
   * (`Matricies.sol:334-349`). Left alone that is a printed row claiming a real
   * value of `0`, authored by the zero address, at midnight on 1 January 1970 —
   * and every one of those three is a lie a voter has no way to detect.
   *
   * The sentinel is recognised by its **timestamp**, which is the only one of the
   * three that cannot occur naturally: `addValue` records `block.timestamp`, so a
   * genuine checkpoint's timestamp is the deployment's era. A real value of `0`
   * by a real author is preserved, which is the case a `value === 0` test would
   * have destroyed.
   */
  async latestValue(kind: MatrixKind, at: MatrixCoordinate): Promise<CellValue | undefined> {
    const functionName = isCategoricalOf(kind)
      ? 'getCategoricalLatestValue'
      : 'getNumericalLatestValue';
    const outcome = await callContract(
      this.client,
      this.address,
      functionName,
      [at.x, at.y],
      { blockNumber: this.at.blockNumber },
    );
    if (outcome.kind !== 'VALUE') return undefined;

    const decoded = outcome.value as
      | { timestamp?: unknown; author?: unknown; value?: unknown }
      | undefined;
    if (
      typeof decoded?.timestamp !== 'number' ||
      typeof decoded.author !== 'string' ||
      typeof decoded.value !== 'bigint'
    ) {
      return undefined;
    }

    if (decoded.timestamp === 0) return { kind: 'NONE' };

    try {
      return {
        kind: 'SET',
        value: decoded.value,
        author: evmAddress(decoded.author),
        recordedAt: unixSeconds(decoded.timestamp),
      };
    } catch {
      return undefined;
    }
  }
}
