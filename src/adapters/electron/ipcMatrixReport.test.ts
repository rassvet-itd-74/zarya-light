import { describe, expect, it, vi } from 'vitest';
import {
  MATRIX_REPORT_FILE_NAME,
  type MatrixReportGateway,
  IpcPayloadError,
  handleGenerateMatrixReport,
} from './ipcHandlers';
import type { MatrixReportPayload, WorkerReply } from './workerProtocol';

/**
 * The report channel, from main's side.
 *
 * Much smaller than issuance's, and the difference is the point: a report is not
 * addressed, so there is no payload to validate and no way for a caller to
 * change what the document says. What remains worth pinning is the four-way
 * outcome — a cancelled dialog is an answer, not a failure — and the fact that
 * the dialog runs before any work, so a cancel leaves nothing behind.
 */

const reply = (overrides: Partial<Extract<WorkerReply, { kind: 'reported' }>> = {}) =>
  ({
    kind: 'reported',
    requestId: 'r1',
    path: 'C:/Users/member/Documents/zarya-matrix-report.pdf',
    pageCount: 3,
    blockNumber: '11642262',
    readAt: 1_756_000_000,
    rows: 12,
    degradedRows: 0,
    empty: false,
    ...overrides,
  }) satisfies WorkerReply;

const gateway = (
  overrides: Partial<MatrixReportGateway> = {},
): MatrixReportGateway & { readonly generated: MatrixReportPayload[] } => {
  const generated: MatrixReportPayload[] = [];
  return {
    generated,
    chooseDestination: async () => 'C:/Users/member/Documents/zarya-matrix-report.pdf',
    generate: async (payload) => {
      generated.push(payload);
      return reply();
    },
    ...overrides,
  };
};

describe('the matrix report channel', () => {
  it('takes no arguments at all', async () => {
    // There is nothing to address: one matrix, one report of it, and everything
    // that decides the content is read inside the worker. An argument here would
    // mean the caller is not the preload surface we shipped.
    //
    // Rejects rather than throws — the guard runs inside an async handler — and
    // `registerIpcHandlers` turns an `IpcPayloadError` into a message the
    // renderer may see, since we wrote it ourselves.
    await expect(handleGenerateMatrixReport(gateway(), ['anything'])).rejects.toThrow(
      IpcPayloadError,
    );
    await expect(handleGenerateMatrixReport(gateway(), [{}])).rejects.toThrow(
      'takes no arguments',
    );
  });

  it('does no work when the payload is refused', async () => {
    const generate = vi.fn();
    const chooseDestination = vi.fn();
    await expect(
      handleGenerateMatrixReport(gateway({ generate, chooseDestination }), ['anything']),
    ).rejects.toThrow(IpcPayloadError);

    expect(chooseDestination).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('asks for a destination before doing any work', async () => {
    // A cancelled dialog must leave nothing behind, and the cheapest way to
    // guarantee that is to have nothing to undo. Here that matters more than it
    // does for issuance: the work after the dialog is tens of seconds of chain
    // reads.
    const generate = vi.fn();
    const outcome = await handleGenerateMatrixReport(
      gateway({ chooseDestination: async () => null, generate }),
    );

    expect(outcome).toEqual({ kind: 'CANCELLED' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('suggests a Latin filename, since it crosses filesystems and email', () => {
    expect(MATRIX_REPORT_FILE_NAME).toBe('zarya-matrix-report.pdf');
    expect(MATRIX_REPORT_FILE_NAME).toMatch(/^[\x20-\x7e]+$/);
  });

  it('passes the chosen destination through, and nothing else', async () => {
    const g = gateway();
    await handleGenerateMatrixReport(g);

    expect(g.generated).toEqual([
      { targetPath: 'C:/Users/member/Documents/zarya-matrix-report.pdf' },
    ]);
  });

  it('carries the block, the counts and the degraded rows back to the UI', async () => {
    // `degradedRows` in particular. A report can be written *and* incomplete, and
    // the page marks those rows — so a result type that dropped the count would
    // let the UI claim a success the document itself contradicts.
    const outcome = await handleGenerateMatrixReport(
      gateway({ generate: async () => reply({ rows: 12, degradedRows: 2 }) }),
    );

    expect(outcome).toEqual({
      kind: 'REPORTED',
      path: 'C:/Users/member/Documents/zarya-matrix-report.pdf',
      pageCount: 3,
      blockNumber: '11642262',
      readAt: 1_756_000_000,
      rows: 12,
      degradedRows: 2,
      empty: false,
    });
  });

  it('keeps a refusal apart from a failure', async () => {
    // A refusal is the application declining with a reason the user may be able
    // to act on — the chain would not answer with a block to read at. A failure
    // is an outage or a bug. Collapsing them would tell someone waiting out a
    // network blip that the application is broken.
    const refused = await handleGenerateMatrixReport(
      gateway({
        generate: async () => ({
          kind: 'refused',
          requestId: 'r1',
          code: 'NO_PINNED_BLOCK',
          message: 'no block to read at',
        }),
      }),
    );
    expect(refused).toEqual({
      kind: 'REFUSED',
      code: 'NO_PINNED_BLOCK',
      message: 'no block to read at',
    });

    const failed = await handleGenerateMatrixReport(
      gateway({
        generate: async () => ({
          kind: 'failure',
          requestId: 'r1',
          message: 'the worker could not reach the provider',
        }),
      }),
    );
    expect(failed).toEqual({
      kind: 'FAILED',
      message: 'the worker could not reach the provider',
    });
  });

  it('treats a reply of the wrong kind as a failure rather than trusting it', async () => {
    // A stale worker build answering an `issued` to a report request. Reported
    // rather than coerced: the two replies have different fields and reading one
    // as the other would put an issuance's field count on a report's result line.
    const outcome = await handleGenerateMatrixReport(
      gateway({
        generate: async () => ({
          kind: 'issued',
          requestId: 'r1',
          operationRef: 'zar-1',
          path: 'C:/somewhere.pdf',
          organIdentifier: null,
          fieldCount: 9,
        }),
      }),
    );

    expect(outcome).toMatchObject({ kind: 'FAILED' });
    expect(outcome).toMatchObject({ message: expect.stringContaining('issued') });
  });
});
