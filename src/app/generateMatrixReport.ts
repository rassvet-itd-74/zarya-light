import {
  type MatrixIndexState,
  emptyMatrixIndexState,
  foldMatrixIndexWindow,
} from '../domain/matrix/matrixIndex';
import { assembleMatrixReport } from '../domain/matrix/matrixReport';
import type { FileSink } from '../domain/ports/FileSink';
import type { MatrixIndex } from '../domain/ports/MatrixIndex';
import type { MatrixReportWriter } from '../domain/ports/MatrixReportWriter';
import type { MatrixSnapshotSource } from '../domain/ports/MatrixSnapshotReader';
import type { OrganResolver } from '../domain/ports/OrganResolver';
import type { UnixSeconds } from '../domain/primitives';
import { planDiscovery } from '../domain/voting/discoveryPlan';

/**
 * Producing the coordinate reference a voter reads before filling in a form.
 *
 * The second use case that changes anything, and it changes far less than the
 * first: issuance records an operation the application is then bound by, while
 * this writes a **disposable document**. Nothing is persisted, no `operationRef`
 * is minted, and running it twice against the same block produces the same
 * bytes. A report is a rendering of chain state, never a record of it — so there
 * is no crash window here worth naming, because there is nothing to reconcile.
 *
 * ## The order, and why it is this order
 *
 * ```text
 * pin a block  ->  project the index up to it  ->  assemble  ->  render  ->  write
 * ```
 *
 * **Pin first.** Everything downstream is bounded by the pinned block, including
 * the event scan, so the block has to be chosen before anything is read. Pinning
 * afterwards would let the index run past the state the values were read at and
 * put a coordinate on the page with no row to describe it.
 *
 * **Project up to the pin, not up to the head.** `ZaryaMatrixSnapshot` pins at
 * `head - confirmations`, so the pin is already the confirmation depth back and
 * re-applying it here would leave the index a further twelve blocks behind for
 * no gain. The scan window is therefore `[deployment, pinned]` inclusive, chunked
 * by the same provider ceiling discovery uses.
 *
 * **Write last.** A refused report leaves no file, which matters more here than
 * it looks: a zero-byte or half-written PDF at a path the user chose is
 * indistinguishable, in a file manager, from a report that came out empty.
 *
 * ## The index is rebuilt every time, and deliberately does not use the cursor
 *
 * `CursorStore` persists a block number and nothing else. The **folded index** —
 * which coordinates exist, which axis labels survived — is not durable anywhere,
 * and resuming a projection from a stored cursor without the state it produced
 * would skip every event before it. That is not a slow report, it is a *wrong*
 * one: coordinates a voter needs, silently absent, with no marker on the page to
 * say so. The projection is complete or it is misleading, and there is no third
 * option this use case is allowed to take.
 *
 * So the whole history is re-scanned on every press. On the current deployment
 * that is roughly 89,000 blocks — eighteen windows, measured at about a second
 * against Sepolia on 2026-09-05 — and it is the honest cost until Phase 7's
 * executor maintains a live index this can read instead. The figure grows with
 * the chain's height and not with anything a user does, so it is worth watching
 * rather than assuming settled.
 *
 * ## A failed scan fails the report
 *
 * A `scan` that throws propagates. It is tempting to fold what did arrive and
 * print the rest, and that is exactly the failure mode the skill forbids: a
 * partial index looks complete, because a coordinate that was never found leaves
 * no gap on the page. Degradation is only ever disclosed for *reads*, where a
 * row exists to carry the marker.
 */

export interface GenerateMatrixReportDeps {
  readonly snapshots: MatrixSnapshotSource;
  readonly events: MatrixIndex;
  /** The reverse half only — synchronous, local, and allowed to answer `undefined`. */
  readonly organs: Pick<OrganResolver, 'label'>;
  readonly reports: MatrixReportWriter;
  readonly files: FileSink;
  /** Nothing before this block exists to find. */
  readonly deploymentBlock: bigint;
  /** Provider ceiling on one `eth_getLogs` range. Defaults to discovery's. */
  readonly maxBlocksPerScan?: bigint;
  /** How many cell reads may be in flight at once. Defaults to the report model's. */
  readonly concurrency?: number;
}

export interface GenerateMatrixReportRequest {
  /** Already chosen by the user, in a dialog main owns. See `FileSink`. */
  readonly targetPath: string;
}

export type MatrixReportRefusalCode =
  /**
   * No block could be pinned, so there is no honest date to stamp. An outage,
   * not a verdict about the matrix.
   */
  | 'NO_PINNED_BLOCK'
  /**
   * There were cells to describe and not one read answered. Kept apart from an
   * empty matrix because printing an outage as an empty matrix would tell a
   * voter their party has no matrix.
   */
  | 'NOTHING_READABLE'
  /** The cursor came back ahead of the pinned block — a reorg or a stale head. */
  | 'CHAIN_INCONSISTENT';

export type GenerateMatrixReportOutcome =
  | {
      readonly kind: 'WRITTEN';
      readonly path: string;
      readonly pageCount: number;
      /** The block every row was read at, and what the page is stamped with. */
      readonly blockNumber: bigint;
      readonly readAt: UnixSeconds;
      readonly rows: number;
      /** Rows carrying at least one field that did not read. */
      readonly degradedRows: number;
      /** No coordinate and no axis label — a young matrix, not a failure. */
      readonly empty: boolean;
      /** How many `eth_getLogs` windows the projection took. */
      readonly scannedWindows: number;
    }
  | {
      readonly kind: 'REFUSED';
      readonly code: MatrixReportRefusalCode;
      readonly message: string;
    };

export async function generateMatrixReport(
  deps: GenerateMatrixReportDeps,
  request: GenerateMatrixReportRequest,
): Promise<GenerateMatrixReportOutcome> {
  const snapshot = await deps.snapshots.pin();
  if (snapshot === undefined) {
    return refused(
      'NO_PINNED_BLOCK',
      'the chain did not answer with a block to read at, so there is no date this report ' +
        'could honestly carry',
    );
  }

  const projected = await project(deps, snapshot.at.blockNumber);
  if (projected.kind === 'REFUSED') return projected;

  const outcome = await assembleMatrixReport({
    index: projected.state.index,
    snapshot,
    organs: deps.organs,
    // Exactly the pinned block: this projection was bounded by it, so there is
    // no gap to disclose. The field exists for Phase 7, where the index comes
    // from an executor cursor that can lag the pin.
    indexedThrough: snapshot.at.blockNumber,
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
  });

  if (outcome.kind === 'FAILED') {
    return refused(
      'NOTHING_READABLE',
      `the matrix has coordinates at block ${snapshot.at.blockNumber} and not one of them could ` +
        'be read, so there is nothing to print but a page of empty rows',
    );
  }

  const rendered = await deps.reports.render(outcome.report);
  await deps.files.write(request.targetPath, rendered.bytes);

  return {
    kind: 'WRITTEN',
    path: request.targetPath,
    pageCount: rendered.pageCount,
    blockNumber: outcome.report.readAt.blockNumber,
    readAt: outcome.report.readAt.timestamp,
    rows: outcome.report.rows.length,
    degradedRows: outcome.report.degradedRows,
    empty: outcome.report.empty,
    scannedWindows: projected.windows,
  };
}

type Projection =
  | { readonly kind: 'PROJECTED'; readonly state: MatrixIndexState; readonly windows: number }
  | Extract<GenerateMatrixReportOutcome, { kind: 'REFUSED' }>;

/**
 * Walks `[deployment, pinned]` in provider-sized windows, folding each.
 *
 * `planDiscovery` is reused rather than reimplemented so the two rules that keep
 * a scan answerable — never ask for a range the provider will refuse, never
 * rescan from the deployment on every poll — stay in one place. Its
 * `confirmations` is zero here because the pin already applied them; passing the
 * default would silently trim another twelve blocks off the projection.
 *
 * The cursor is local to this call. It advances a window at a time only so the
 * plan can be recomputed, and it is never read from or written to the store —
 * see the note on the use case.
 */
async function project(
  deps: GenerateMatrixReportDeps,
  pinnedBlock: bigint,
): Promise<Projection> {
  let state = emptyMatrixIndexState();
  let cursor: bigint | undefined;
  let windows = 0;

  for (;;) {
    const plan = planDiscovery({
      cursor,
      headBlock: pinnedBlock,
      deploymentBlock: deps.deploymentBlock,
      confirmations: 0n,
      ...(deps.maxBlocksPerScan === undefined
        ? {}
        : { maxBlocksPerScan: deps.maxBlocksPerScan }),
    });

    if (plan.kind === 'UP_TO_DATE') return { kind: 'PROJECTED', state, windows };
    if (plan.kind === 'CURSOR_AHEAD') {
      // Unreachable from a cursor this function owns, and handled rather than
      // asserted: the arm exists in the plan, and a report that silently treated
      // it as "done" would print a matrix missing everything after the pin.
      return refused(
        'CHAIN_INCONSISTENT',
        `the projection reached block ${plan.cursor}, past the pinned ${plan.confirmedHead}`,
      );
    }

    const window = await deps.events.scan(plan.fromBlock, plan.toBlock);
    state = foldMatrixIndexWindow(state, window.events);
    cursor = plan.toBlock;
    windows += 1;
  }
}

const refused = (
  code: MatrixReportRefusalCode,
  message: string,
): Extract<GenerateMatrixReportOutcome, { kind: 'REFUSED' }> => ({
  kind: 'REFUSED',
  code,
  message,
});
