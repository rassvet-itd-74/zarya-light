import { describe, expect, it, vi } from 'vitest';
import {
  type IssueTemplateGateway,
  IpcPayloadError,
  handleIssueTemplate,
  parseIssueTemplateInput,
  suggestedFileName,
} from './ipcHandlers';
import type { IssueTemplatePayload, WorkerReply } from './workerProtocol';

/**
 * Issuance, from main's side.
 *
 * Two things live here and nowhere else: the payload validation that makes this
 * the trust boundary, and the four-way outcome that keeps "the user changed
 * their mind" apart from "the document was never written".
 */

describe('the issuance payload', () => {
  it('is rebuilt rather than passed through, so an unvalidated field cannot ride along', () => {
    const parsed = parseIssueTemplateInput([
      {
        operationType: 'CAST_VOTE',
        votingId: '7',
        // A path the renderer named. The destination comes from a save dialog in
        // main, and a renderer that could name a path could name any path.
        targetPath: '/etc/passwd',
        somethingElse: true,
      },
    ]);

    expect(parsed).toEqual({ operationType: 'CAST_VOTE', votingId: '7' });
    expect(parsed).not.toHaveProperty('targetPath');
    expect(parsed).not.toHaveProperty('somethingElse');
  });

  it('refuses a payload that could not have come from our preload surface', () => {
    // A compromised renderer talks to `ipcRenderer` directly and never touches
    // the preload we shipped, which is why this is the boundary rather than the
    // UI.
    expect(() => parseIssueTemplateInput([])).toThrow(IpcPayloadError);
    expect(() => parseIssueTemplateInput([{}, {}])).toThrow('takes one argument');
    expect(() => parseIssueTemplateInput(['not an object'])).toThrow('takes an object');
    expect(() => parseIssueTemplateInput([{}])).toThrow('must name an operation type');
    expect(() => parseIssueTemplateInput([{ operationType: '' }])).toThrow(
      'must name an operation type',
    );
  });

  it('bounds the strings, because a form field is not a place for a megabyte', () => {
    expect(() =>
      parseIssueTemplateInput([{ operationType: 'CAST_VOTE', votingId: 'x'.repeat(65) }]),
    ).toThrow('must be a short string');
  });

  it('bounds the organ number to the safe integer range', () => {
    // It is rendered decimally into an organ identifier and has to round-trip
    // exactly: a value past the safe range would hash to a different organ than
    // the one displayed.
    for (const organNumber of [1.5, -1, Number.MAX_SAFE_INTEGER + 2, '3']) {
      expect(() =>
        parseIssueTemplateInput([{ operationType: 'CREATE_MEMBERSHIP_VOTING', organNumber }]),
      ).toThrow('non-negative safe integer');
    }
    expect(
      parseIssueTemplateInput([{ operationType: 'CREATE_MEMBERSHIP_VOTING', organNumber: 0 }]),
    ).toMatchObject({ organNumber: 0 });
  });

  it('does not check what an operation type means — the worker owns that', () => {
    // A guard here that knew the eleven types would be another list to keep in
    // step with the intent model. Shape is all this layer can promise.
    expect(parseIssueTemplateInput([{ operationType: 'NOT_A_REAL_OPERATION' }])).toEqual({
      operationType: 'NOT_A_REAL_OPERATION',
    });
  });
});

describe('handleIssueTemplate', () => {
  const gateway = (over: Partial<IssueTemplateGateway> = {}): IssueTemplateGateway => ({
    chooseDestination: async () => '/tmp/form.pdf',
    issue: async (): Promise<WorkerReply> => ({
      kind: 'issued',
      requestId: 'r1',
      operationRef: 'zar-1',
      path: '/tmp/form.pdf',
      organIdentifier: '95.СОВ-7',
      fieldCount: 12,
    }),
    ...over,
  });

  const input = [{ operationType: 'CREATE_MEMBERSHIP_VOTING', organType: 'CentralSoviet' }];

  it('passes the chosen path inwards, never one the renderer named', async () => {
    let sent: IssueTemplatePayload | undefined;
    const result = await handleIssueTemplate(
      gateway({
        chooseDestination: async () => '/home/user/Documents/form.pdf',
        issue: async (payload) => {
          sent = payload;
          return {
            kind: 'issued',
            requestId: 'r1',
            operationRef: 'zar-1',
            path: payload.targetPath,
            organIdentifier: null,
            fieldCount: 9,
          };
        },
      }),
      input,
    );

    expect(sent?.targetPath).toBe('/home/user/Documents/form.pdf');
    expect(result).toMatchObject({ kind: 'ISSUED', path: '/home/user/Documents/form.pdf' });
  });

  it('does no work at all when the dialog is cancelled', async () => {
    // A cancelled dialog must leave no row and no file, and the cheapest way to
    // guarantee that is to have nothing to undo.
    const issue = vi.fn();
    const result = await handleIssueTemplate(
      gateway({ chooseDestination: async () => null, issue }),
      input,
    );

    expect(result).toEqual({ kind: 'CANCELLED' });
    expect(issue).not.toHaveBeenCalled();
  });

  it('keeps a refusal apart from a failure', async () => {
    // One the user can fix, the other they cannot. Collapsing them would either
    // alarm someone who mistyped or reassure someone whose document is missing.
    const refused = await handleIssueTemplate(
      gateway({
        issue: async () => ({
          kind: 'refused',
          requestId: 'r1',
          code: 'ORGAN_REQUIRED',
          message: 'name an organ',
        }),
      }),
      input,
    );
    expect(refused).toEqual({
      kind: 'REFUSED',
      code: 'ORGAN_REQUIRED',
      message: 'name an organ',
    });

    const failed = await handleIssueTemplate(
      gateway({
        issue: async () => ({ kind: 'failure', requestId: 'r1', message: 'no provider' }),
      }),
      input,
    );
    expect(failed).toEqual({ kind: 'FAILED', message: 'no provider' });
  });

  it('treats a reply of the wrong kind as a failure rather than trusting it', async () => {
    // A version skew between a fresh main process and a stale worker build.
    const result = await handleIssueTemplate(
      gateway({
        issue: async () => ({ kind: 'network', requestId: 'r1', status: {} as never }),
      }),
      input,
    );

    expect(result).toMatchObject({ kind: 'FAILED' });
  });

  it('validates before it opens a dialog', async () => {
    const chooseDestination = vi.fn();

    await expect(handleIssueTemplate(gateway({ chooseDestination }), [{}])).rejects.toThrow(
      IpcPayloadError,
    );
    expect(chooseDestination).not.toHaveBeenCalled();
  });
});

describe('the suggested filename', () => {
  it('is ASCII and recognisable, because a filename crosses filesystems', () => {
    // The document itself is Russian throughout; its name is not, and a Cyrillic
    // filename survives email and foreign filesystems badly.
    expect(suggestedFileName('CREATE_MEMBERSHIP_VOTING')).toBe(
      'zarya-create-membership-voting.pdf',
    );
    expect(suggestedFileName('CAST_VOTE')).toBe('zarya-cast-vote.pdf');
  });
});
