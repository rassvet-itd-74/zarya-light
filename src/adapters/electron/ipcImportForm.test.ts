import { describe, expect, it, vi } from 'vitest';
import {
  type ImportFormGateway,
  IpcPayloadError,
  handleImportForm,
} from './ipcHandlers';
import type { ImportFormPayload, WorkerReply } from './workerProtocol';

/**
 * The import channel, from main's side.
 *
 * The one channel that hands a worker a path it will **read**, which is why the
 * renderer cannot name it and why the dialog runs before anything else. The
 * outcome split is the same four as issuance and for the same reason: a
 * cancelled dialog is an answer, a refusal is fixable, a failure is not.
 */

const reply = (overrides: Partial<Extract<WorkerReply, { kind: 'imported' }>> = {}) =>
  ({
    kind: 'imported',
    requestId: 'r1',
    operationRef: 'zar-a6c37304-fb51-4aff-ad57-e28be35c3129',
    operationType: 'CREATE_MEMBERSHIP_VOTING',
    fields: [
      { label: 'member', value: '0x1111111111111111111111111111111111111111' },
      { label: 'organType', value: 'LocalSoviet' },
      { label: 'regionSubjectCode', value: '95' },
    ],
    warnings: [],
    ...overrides,
  }) satisfies WorkerReply;

const gateway = (
  overrides: Partial<ImportFormGateway> = {},
): ImportFormGateway & { readonly asked: ImportFormPayload[] } => {
  const asked: ImportFormPayload[] = [];
  return {
    asked,
    chooseSource: async () => 'C:/Users/member/Documents/filled.pdf',
    importForm: async (payload) => {
      asked.push(payload);
      return reply();
    },
    ...overrides,
  };
};

describe('the import channel', () => {
  it('takes no arguments, and does nothing when given one', async () => {
    // Which file is the dialog's answer and which operation is the file's. An
    // argument here means the caller is not the preload surface we shipped.
    const chooseSource = vi.fn();
    const importForm = vi.fn();

    await expect(
      handleImportForm(gateway({ chooseSource, importForm }), ['C:/etc/passwd']),
    ).rejects.toThrow(IpcPayloadError);

    expect(chooseSource).not.toHaveBeenCalled();
    expect(importForm).not.toHaveBeenCalled();
  });

  it('asks for a file before doing any work', async () => {
    const importForm = vi.fn();
    const outcome = await handleImportForm(
      gateway({ chooseSource: async () => null, importForm }),
    );

    expect(outcome).toEqual({ kind: 'CANCELLED' });
    expect(importForm).not.toHaveBeenCalled();
  });

  it('passes the chosen path through, and nothing else', async () => {
    const g = gateway();
    await handleImportForm(g);
    expect(g.asked).toEqual([{ sourcePath: 'C:/Users/member/Documents/filled.pdf' }]);
  });

  it('carries the fields and the warnings back to the UI', async () => {
    // The fields are what a member checks before anything is submitted, and the
    // warnings are tamper evidence that a successful import must still show.
    const outcome = await handleImportForm(
      gateway({
        importForm: async () =>
          reply({
            warnings: [
              {
                code: 'CONTEXT_TAMPERED',
                field: 'zarya.context.organ',
                message: 'edited in the file',
              },
            ],
          }),
      }),
    );

    expect(outcome).toMatchObject({
      kind: 'IMPORTED',
      operationType: 'CREATE_MEMBERSHIP_VOTING',
      warnings: [{ code: 'CONTEXT_TAMPERED', field: 'zarya.context.organ' }],
    });
    if (outcome.kind !== 'IMPORTED') return;
    expect(outcome.fields).toHaveLength(3);
    // Strings, all of them — a coordinate that arrived as a number would address
    // a different cell.
    for (const field of outcome.fields) expect(typeof field.value).toBe('string');
  });

  it('keeps a refusal apart from a failure', async () => {
    const refused = await handleImportForm(
      gateway({
        importForm: async () => ({
          kind: 'refused',
          requestId: 'r1',
          code: 'ALREADY_IMPORTED',
          message: 'a copy of this form has already been imported',
        }),
      }),
    );
    expect(refused).toMatchObject({ kind: 'REFUSED', code: 'ALREADY_IMPORTED' });

    const failed = await handleImportForm(
      gateway({
        importForm: async () => ({
          kind: 'failure',
          requestId: 'r1',
          message: 'the local database could not be opened',
        }),
      }),
    );
    expect(failed).toMatchObject({ kind: 'FAILED' });
  });

  it('treats a reply of the wrong kind as a failure rather than trusting it', async () => {
    const outcome = await handleImportForm(
      gateway({
        importForm: async () => ({
          kind: 'reported',
          requestId: 'r1',
          path: 'C:/report.pdf',
          pageCount: 1,
          blockNumber: '1',
          readAt: 1,
          rows: 0,
          degradedRows: 0,
          empty: true,
        }),
      }),
    );

    expect(outcome).toMatchObject({ kind: 'FAILED' });
  });
});
