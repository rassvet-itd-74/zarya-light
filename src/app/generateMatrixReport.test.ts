import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFormFields } from '../adapters/forms/pdfFormParser';
import { MatrixReportRenderer } from '../adapters/forms/renderMatrixReport';
import {
  type CategoricalCell,
  type MatrixCoordinate,
  axisLabel,
  cellBinding,
  coordinateKey,
  matrixCoordinate,
} from '../domain/matrix/matrix';
import type { MatrixIndexEvent } from '../domain/matrix/matrixIndex';
import type { MatrixReport } from '../domain/matrix/matrixReport';
import type { FileSink } from '../domain/ports/FileSink';
import type { MatrixIndex, ScannedIndexWindow } from '../domain/ports/MatrixIndex';
import type { MatrixReportWriter } from '../domain/ports/MatrixReportWriter';
import type {
  MatrixSnapshotReader,
  MatrixSnapshotSource,
  ReadPoint,
} from '../domain/ports/MatrixSnapshotReader';
import type { OrganResolver } from '../domain/ports/OrganResolver';
import { bytes32, evmAddress, unixSeconds } from '../domain/primitives';
import {
  type GenerateMatrixReportDeps,
  generateMatrixReport,
} from './generateMatrixReport';

/**
 * The use case behind the report button, and what it is tested for is mostly
 * what it must **not** do: print a page it could not date, print an outage as an
 * empty matrix, leave a half-written file where a user chose a path, or project
 * part of the history and present the result as complete.
 *
 * The pieces underneath — the fold, the report model, the renderer — have their
 * own suites. What only exists here is the *order*, and the fact that the
 * projection is bounded by the pinned block rather than by a stored cursor.
 */

const DEPLOYMENT = 11_553_464n;
/** Deployment + 88,798, the real span on the configured deployment as of 2026-09-05. */
const PINNED_BLOCK = 11_642_262n;
/** A real Sepolia-shaped chain timestamp, so nothing here resembles Date.now(). */
const PINNED_AT: ReadPoint = {
  blockNumber: PINNED_BLOCK,
  timestamp: unixSeconds(1_756_000_000),
};

const ORGAN = bytes32(`0x${'11'.repeat(32)}`);
const AUTHOR = evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD');
const CELL = matrixCoordinate(3n, 4n);

const categoricalCell = (): CategoricalCell => ({
  binding: cellBinding(ORGAN),
  allowedCategories: [1n, 2n],
  sampleLength: 1n,
});

const categoryAdded = (at: MatrixCoordinate, blockNumber: bigint): MatrixIndexEvent => ({
  kind: 'CATEGORY_ADDED',
  at,
  category: 1n,
  position: { blockNumber, logIndex: 0 },
});

/** Answers every read, so a row is fully populated rather than degraded. */
const readableSnapshot = (at: ReadPoint = PINNED_AT): MatrixSnapshotReader => ({
  at,
  categoricalCell: async (cell) =>
    coordinateKey(cell) === coordinateKey(CELL) ? categoricalCell() : undefined,
  numericalCell: async () => undefined,
  theme: async () => axisLabel('Экономика'),
  statement: async () => axisLabel('Налоги'),
  categoryName: async () => axisLabel('за'),
  latestValue: async () => ({
    kind: 'SET',
    value: 1n,
    author: AUTHOR,
    recordedAt: unixSeconds(1_755_000_000),
  }),
});

/** Answers nothing — every read times out. The outage case. */
const silentSnapshot = (): MatrixSnapshotReader => ({
  at: PINNED_AT,
  categoricalCell: async () => undefined,
  numericalCell: async () => undefined,
  theme: async () => undefined,
  statement: async () => undefined,
  categoryName: async () => undefined,
  latestValue: async () => undefined,
});

interface Harness {
  readonly deps: GenerateMatrixReportDeps;
  readonly windows: ScannedIndexWindow[];
  readonly written: { path: string; bytes: Uint8Array }[];
  readonly order: string[];
}

const harness = (overrides: Partial<GenerateMatrixReportDeps> = {}): Harness => {
  const windows: ScannedIndexWindow[] = [];
  const written: { path: string; bytes: Uint8Array }[] = [];
  const order: string[] = [];

  const events: MatrixIndex = {
    scan: async (fromBlock, toBlock) => {
      // The one event lands in whichever window covers it, so the fold sees it
      // exactly once however the range is chunked.
      const at = DEPLOYMENT + 10n;
      const window: ScannedIndexWindow = {
        fromBlock,
        toBlock,
        events: at >= fromBlock && at <= toBlock ? [categoryAdded(CELL, at)] : [],
      };
      windows.push(window);
      return window;
    },
  };

  const snapshots: MatrixSnapshotSource = { pin: async () => readableSnapshot() };

  const organs: Pick<OrganResolver, 'label'> = {
    label: (organ) => (organ === ORGAN ? '74.СОВ' : undefined),
  };

  const reports: MatrixReportWriter = {
    render: async () => {
      order.push('render');
      return { bytes: new Uint8Array([1, 2, 3]), pageCount: 2 };
    },
  };

  const files: FileSink = {
    write: async (path, bytes) => {
      order.push('write');
      written.push({ path, bytes });
    },
  };

  return {
    deps: {
      snapshots,
      events,
      organs,
      reports,
      files,
      deploymentBlock: DEPLOYMENT,
      ...overrides,
    },
    windows,
    written,
    order,
  };
};

const run = async (h: Harness) =>
  await generateMatrixReport(h.deps, { targetPath: 'C:/report.pdf' });

describe('generateMatrixReport', () => {
  it('writes the report and reports the block it was read at', async () => {
    const h = harness();
    const outcome = await run(h);

    expect(outcome.kind).toBe('WRITTEN');
    if (outcome.kind !== 'WRITTEN') return;

    expect(outcome.path).toBe('C:/report.pdf');
    expect(outcome.pageCount).toBe(2);
    expect(outcome.rows).toBe(1);
    expect(outcome.degradedRows).toBe(0);
    expect(outcome.empty).toBe(false);

    // Chain time, from the pinned block — never the workstation's. A report
    // stamped with a system clock claims a freshness the chain never asserted.
    expect(outcome.blockNumber).toBe(PINNED_BLOCK);
    expect(outcome.readAt).toBe(PINNED_AT.timestamp);

    expect(h.written).toHaveLength(1);
    expect(h.written[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('projects the whole history, from the deployment block to the pin', async () => {
    // The assertion that matters is the *first* window's `fromBlock`. A
    // projection resumed from a stored cursor would start somewhere later and
    // silently omit every coordinate before it — and nothing on the finished
    // page could reveal the omission, because a coordinate that was never found
    // leaves no gap. There is no cursor store in these dependencies, and this is
    // what asserts that staying true is not merely an oversight.
    const h = harness({ maxBlocksPerScan: 5_000n });
    const outcome = await run(h);

    expect(outcome.kind).toBe('WRITTEN');
    expect(h.windows[0]?.fromBlock).toBe(DEPLOYMENT);
    expect(h.windows.at(-1)?.toBlock).toBe(PINNED_BLOCK);

    // Contiguous and non-overlapping, inclusive at both ends as eth_getLogs is.
    for (const [i, window] of h.windows.entries()) {
      if (i === 0) continue;
      expect(window.fromBlock).toBe((h.windows[i - 1]?.toBlock ?? 0n) + 1n);
    }

    // 88,799 blocks inclusive at 5,000 a window.
    expect(h.windows).toHaveLength(18);
    if (outcome.kind === 'WRITTEN') expect(outcome.scannedWindows).toBe(18);
  });

  it('never scans past the pinned block', async () => {
    // The pin is already `head - confirmations`, so the projection must not
    // apply a second confirmation depth — nor run past the block the values were
    // read at, which would put a coordinate on the page with no row to describe
    // it.
    const h = harness({ maxBlocksPerScan: 5_000n });
    await run(h);

    for (const window of h.windows) {
      expect(window.toBlock).toBeLessThanOrEqual(PINNED_BLOCK);
    }
  });

  it('refuses when no block could be pinned, and writes nothing', async () => {
    const h = harness({ snapshots: { pin: async () => undefined } });
    const outcome = await run(h);

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'NO_PINNED_BLOCK' });
    expect(h.written).toHaveLength(0);
    // Refused before a single log was requested: there is nothing to scan
    // towards without a block to stop at.
    expect(h.windows).toHaveLength(0);
  });

  it('refuses an outage rather than printing it as an empty matrix', async () => {
    const h = harness({ snapshots: { pin: async () => silentSnapshot() } });
    const outcome = await run(h);

    expect(outcome).toMatchObject({ kind: 'REFUSED', code: 'NOTHING_READABLE' });
    expect(h.written).toHaveLength(0);
  });

  it('fails the report when a scan fails, rather than printing a partial index', async () => {
    const failing: MatrixIndex = {
      scan: async () => {
        throw new Error('eth_getLogs: request limit exceeded');
      },
    };
    const h = harness({ events: failing });

    await expect(run(h)).rejects.toThrow('request limit exceeded');
    expect(h.written).toHaveLength(0);
  });

  it('writes the file only after the document has been rendered', async () => {
    // A render that throws must leave nothing at the path the user chose: a
    // half-written PDF is indistinguishable, in a file manager, from a report
    // that came out empty.
    const h = harness();
    await run(h);

    expect(h.order).toEqual(['render', 'write']);
  });

  it('renders an empty matrix as a report rather than a refusal', async () => {
    // A young matrix is a normal state. The axis inventory is what a voter needs
    // in order to propose a *new* value, and it is the half that is populated
    // first.
    const quiet: MatrixIndex = {
      scan: async (fromBlock, toBlock) => ({ fromBlock, toBlock, events: [] }),
    };
    const h = harness({ events: quiet, maxBlocksPerScan: 100_000n });
    const outcome = await run(h);

    expect(outcome.kind).toBe('WRITTEN');
    if (outcome.kind !== 'WRITTEN') return;
    expect(outcome.empty).toBe(true);
    expect(outcome.rows).toBe(0);
    expect(h.written).toHaveLength(1);
  });

  it('produces a real PDF through the real renderer, which ingestion then refuses', async () => {
    // The seam this suite otherwise fakes. The renderer's own tests cover what a
    // report document *is*; what only shows up here is whether the model **this
    // use case** assembles is one the renderer can draw at all — a question no
    // hand-built fixture asks, because a fixture is written to be renderable.
    //
    // Ingestion's refusal is re-asserted rather than delegated because it is the
    // property that keeps a reference sheet out of the submission path. It comes
    // for free — a report has no `schemaVersion` because it has no fields — and
    // free is exactly the kind of guarantee that quietly stops holding.
    const rendered = new MatrixReportRenderer({
      fontRegular: readFileSync('src/assets/pt-sans/PTSans-Regular.ttf'),
      fontBold: readFileSync('src/assets/pt-sans/PTSans-Bold.ttf'),
      logoPng: readFileSync('src/assets/logo.png'),
    });
    const h = harness({ reports: rendered, maxBlocksPerScan: 100_000n });
    const outcome = await run(h);

    expect(outcome.kind).toBe('WRITTEN');
    const bytes = h.written[0]?.bytes;
    expect(bytes).toBeDefined();
    if (bytes === undefined) return;

    expect(bytes.byteLength).toBeGreaterThan(0);
    const parsed = await parseFormFields(bytes);
    expect(parsed.kind).not.toBe('FIELDS');
  });

  it('passes the pinned block through as the index bound, so no gap is disclosed', async () => {
    // `indexBehindBy` exists for Phase 7, where the index comes from an executor
    // cursor that can lag the pin. Here the projection is built *to* the pin, so
    // a non-undefined gap would mean this use case had introduced one.
    const seen: MatrixReport[] = [];
    const h = harness({
      reports: {
        render: async (report) => {
          seen.push(report);
          return { bytes: new Uint8Array([0]), pageCount: 1 };
        },
      },
      maxBlocksPerScan: 100_000n,
    });
    await run(h);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ indexBehindBy: undefined });
    // And the pin itself reached the model, so the stamp on the page is the
    // block the rows were read at.
    expect(seen[0]?.readAt).toEqual(PINNED_AT);
  });
});
