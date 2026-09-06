import { describe, expect, it, vi } from 'vitest';
import type { GetAppStatusDeps, WorkerProbe } from '../../app/getAppStatus';
import { loadConfig } from '../config/appConfig';
import { IPC_CHANNELS } from './ipcContract';
import type { WorkerReply } from './workerProtocol';
import {
  IpcPayloadError,
  assertNoPayload,
  handleGetAppStatus,
  handleSubmitOperation,
  pushWorkerHealth,
  registerIpcHandlers,
} from './ipcHandlers';

const RPC_WITH_KEY = 'https://sepolia.example.com/v2/PROJECT-KEY-DO-NOT-LEAK';

const deps = (worker: Partial<WorkerProbe> = {}): GetAppStatusDeps => ({
  publicConfig: loadConfig({
    env: { ZARYA_RPC_URL: RPC_WITH_KEY, ZARYA_MEMBER_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
    appVersion: '0.0.1-test',
  }).publicConfig,
  worker: {
    health: () => 'HEALTHY',
    probe: async () => ({ protocolVersion: 2, uptimeSeconds: 42 }),
    network: async () => ({
      status: 'OK' as const,
      detail: 'Connected to Sepolia at block 9000000.',
      chainId: 11155111,
      blockNumber: '9000000',
      transient: false,
      usable: true,
    }),
    ...worker,
  },
});

describe('assertNoPayload', () => {
  it('accepts a call with no arguments', () => {
    expect(() => assertNoPayload('c', [])).not.toThrow();
  });

  it('rejects any argument', () => {
    // The preload surface never sends one, so an argument here means the caller
    // is not the preload surface we shipped.
    expect(() => assertNoPayload('c', [undefined])).toThrow(IpcPayloadError);
    expect(() => assertNoPayload('c', [{ __proto__: null }])).toThrow(IpcPayloadError);
  });
});

describe('handleGetAppStatus', () => {
  it('answers with a serializable status', async () => {
    const status = await handleGetAppStatus(deps());
    expect(status.chainId).toBe(11155111);
    expect(status.networkName).toBe('Sepolia');
    expect(status.worker).toEqual({ health: 'HEALTHY', protocolVersion: 2, uptimeSeconds: 42 });
    expect(status.network).toMatchObject({ status: 'OK', usable: true, chainId: 11155111 });
    // Whatever else changes, the response must survive structured cloning.
    expect(() => structuredClone(status)).not.toThrow();
  });

  it('never carries a secret', async () => {
    const status = await handleGetAppStatus(deps());
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('PROJECT-KEY-DO-NOT-LEAK');
    expect(serialized).not.toContain('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    expect(status.rpcHost).toBe('sepolia.example.com');
    // False regardless of the environment: the wallet is generated and stored
    // encrypted, so configuration has nothing to say about it.
    expect(status.memberSignerConfigured).toBe(false);
  });

  it('reports an unanswering worker as unknown, not as zero', async () => {
    const status = await handleGetAppStatus(
      deps({ health: () => 'DEGRADED', probe: async () => null }),
    );
    expect(status.worker).toEqual({
      health: 'DEGRADED',
      protocolVersion: null,
      uptimeSeconds: null,
    });
  });

  it('distinguishes an unchecked network from a failed one', async () => {
    // The worker could not be asked. That must not render as a rejected
    // network, or a transient outage looks like a misconfigured client.
    const status = await handleGetAppStatus(deps({ network: async () => null }));

    expect(status.network.status).toBe('NOT_CHECKED');
    expect(status.network.usable).toBe(false);
    expect(status.network.transient).toBe(true);
  });

  it('rejects a payload it was not supposed to receive', async () => {
    await expect(handleGetAppStatus(deps(), ['unexpected'])).rejects.toThrow(IpcPayloadError);
  });
});

describe('registerIpcHandlers', () => {
  /**
   * A gateway that would issue if asked. These tests are about registration and
   * error sanitizing, so it exists to be present rather than to be exercised —
   * the issuance path has its own tests below.
   */
  const stubIssuance = () => ({
    chooseDestination: async () => null,
    issue: async () => ({
      kind: 'failure' as const,
      requestId: 'r1',
      message: 'not used here',
    }),
  });

  const stubMatrixReport = () => ({
    chooseDestination: async () => null,
    generate: async () => ({
      kind: 'failure' as const,
      requestId: 'r1',
      message: 'not used here',
    }),
  });

  const stubImportForm = () => ({
    chooseSource: async () => null,
    importForm: async () => ({
      kind: 'failure' as const,
      requestId: 'r1',
      message: 'not used here',
    }),
  });

  const fakeIpcMain = () => {
    const handlers = new Map<
      string,
      (event: unknown, ...args: unknown[]) => unknown
    >();
    return {
      handlers,
      ipcMain: {
        handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
          handlers.set(channel, listener);
        },
      } as never,
    };
  };

  const stubSubmit = () => ({
    // Declines, so registration tests can never reach a send path even by
    // accident. A stub that confirmed would make this file the one place in the
    // suite where a broadcast is one wrong wire away.
    confirm: async () => false,
    submitOperation: async () => ({
      kind: 'failure' as const,
      requestId: 'r1',
      message: 'not used here',
    }),
  });

  it('registers exactly the channels in the contract', () => {
    const { handlers, ipcMain } = fakeIpcMain();
    registerIpcHandlers({
      ipcMain,
      deps: deps(),
      issuance: stubIssuance(),
      matrixReport: stubMatrixReport(),
      importForm: stubImportForm(),
      submitOperation: stubSubmit(),
    });
    expect([...handlers.keys()]).toEqual([
      IPC_CHANNELS.getAppStatus,
      IPC_CHANNELS.issueTemplate,
      IPC_CHANNELS.generateMatrixReport,
      IPC_CHANNELS.importForm,
      IPC_CHANNELS.submitOperation,
    ]);
  });

  it('sanitizes an unexpected failure and reports the real one to main only', async () => {
    const { handlers, ipcMain } = fakeIpcMain();
    const onError = vi.fn();
    const boom = new Error('RPC key abc123 rejected at /home/user/app/secret.ts:12');

    registerIpcHandlers({
      ipcMain,
      deps: deps({
        probe: async () => {
          throw boom;
        },
      }),
      issuance: stubIssuance(),
      matrixReport: stubMatrixReport(),
      importForm: stubImportForm(),
      submitOperation: stubSubmit(),
      onError,
    });

    const handler = handlers.get(IPC_CHANNELS.getAppStatus);
    await expect(handler?.(null)).rejects.toThrow('zarya:get-app-status failed');
    // The renderer got a generic message; main got the original.
    await expect(handler?.(null)).rejects.not.toThrow('abc123');
    expect(onError).toHaveBeenCalledWith(IPC_CHANNELS.getAppStatus, boom);
  });

  it('passes our own validation message through, since we wrote it', async () => {
    const { handlers, ipcMain } = fakeIpcMain();
    registerIpcHandlers({
      ipcMain,
      deps: deps(),
      issuance: stubIssuance(),
      matrixReport: stubMatrixReport(),
      importForm: stubImportForm(),
      submitOperation: stubSubmit(),
    });

    const handler = handlers.get(IPC_CHANNELS.getAppStatus);
    await expect(handler?.(null, 'unexpected')).rejects.toThrow('takes no arguments');
  });
});

describe('pushWorkerHealth', () => {
  it('sends to live windows and skips destroyed ones', () => {
    const live = { isDestroyed: () => false, send: vi.fn() };
    const dead = { isDestroyed: () => true, send: vi.fn() };

    pushWorkerHealth([live, dead], 'DEGRADED');

    expect(live.send).toHaveBeenCalledWith(IPC_CHANNELS.workerHealth, 'DEGRADED');
    expect(dead.send).not.toHaveBeenCalled();
  });

  it('survives a window that goes away between the check and the send', () => {
    // Observed in a real run: a window reports itself alive while its render
    // frame is already gone, and `send` throws. This push is best-effort UI —
    // the renderer reads the same health from `getAppStatus` — so a throw here
    // must not escape into a supervisor event handler with no caller to catch it.
    const vanishing = {
      isDestroyed: () => false,
      send: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    };
    const live = { isDestroyed: () => false, send: vi.fn() };

    expect(() => pushWorkerHealth([vanishing, live], 'HEALTHY')).not.toThrow();
    // And the windows after it still get their push.
    expect(live.send).toHaveBeenCalledWith(IPC_CHANNELS.workerHealth, 'HEALTHY');
  });
});

describe('handleSubmitOperation', () => {
  /**
   * The confirmation is the asking hard rule 1 requires, so the test that
   * matters most here is the negative one: **a member who says no must not have
   * reached the worker.** Everything else in this block is ordinary mapping.
   */
  const gateway = (over: Partial<{ confirm: boolean; reply: WorkerReply }> = {}) => {
    const submitted: unknown[] = [];
    return {
      submitted,
      gateway: {
        confirm: async () => over.confirm ?? true,
        submitOperation: async (payload: unknown) => {
          submitted.push(payload);
          return (
            over.reply ?? {
              kind: 'submitted' as const,
              requestId: 'r1',
              operationRef: 'op-1',
              partial: false,
              attempts: [{ attemptId: 'a1', hash: '0xabc', nonce: 4 }],
            }
          );
        },
      },
    };
  };

  it('sends nothing when the member declines', async () => {
    const { gateway: g, submitted } = gateway({ confirm: false });

    const result = await handleSubmitOperation(g, [{ operationRef: 'op-1' }]);

    expect(result).toEqual({ kind: 'DECLINED' });
    // The whole point: not merely a DECLINED result, but no request at all.
    expect(submitted).toEqual([]);
  });

  it('passes the reference and nothing else to the worker', async () => {
    const { gateway: g, submitted } = gateway();

    await handleSubmitOperation(g, [
      { operationRef: 'op-1', data: '0xdeadbeef', to: '0xevil' },
    ]);

    // Rebuilt rather than forwarded, so a field nobody validated cannot ride
    // along into the one message that leads to a transaction.
    expect(submitted).toEqual([{ operationRef: 'op-1' }]);
  });

  it('reports what was sent', async () => {
    const { gateway: g } = gateway();

    expect(await handleSubmitOperation(g, [{ operationRef: 'op-1' }])).toEqual({
      kind: 'SENT',
      operationRef: 'op-1',
      partial: false,
      attempts: [{ attemptId: 'a1', hash: '0xabc', nonce: 4 }],
    });
  });

  it('keeps a partial send a send, with its reason', async () => {
    // A threshold configuration is three transactions with no atomicity across
    // them. Presenting this as a failure would tell a member nothing happened
    // while an organ is already half configured.
    const { gateway: g } = gateway({
      reply: {
        kind: 'submitted',
        requestId: 'r1',
        operationRef: 'op-1',
        partial: true,
        attempts: [{ attemptId: 'a1', hash: '0xabc', nonce: 4 }],
        message: 'setMinimumApprovalPercentage: the provider did not answer',
      },
    });

    const result = await handleSubmitOperation(g, [{ operationRef: 'op-1' }]);

    expect(result).toMatchObject({ kind: 'SENT', partial: true });
    expect(result.kind === 'SENT' && result.message).toContain('did not answer');
  });

  it('refuses a payload that could not have come from the preload surface', async () => {
    const { gateway: g, submitted } = gateway();

    await expect(handleSubmitOperation(g, [])).rejects.toBeInstanceOf(IpcPayloadError);
    await expect(handleSubmitOperation(g, ['op-1'])).rejects.toBeInstanceOf(IpcPayloadError);
    await expect(handleSubmitOperation(g, [{ operationRef: '   ' }])).rejects.toBeInstanceOf(
      IpcPayloadError,
    );
    await expect(handleSubmitOperation(g, [{ operationRef: 7 }])).rejects.toBeInstanceOf(
      IpcPayloadError,
    );
    // Rejected before the dialog, so a malformed message cannot even raise one.
    expect(submitted).toEqual([]);
  });

  it('passes a refusal through with its code', async () => {
    const { gateway: g } = gateway({
      reply: { kind: 'refused', requestId: 'r1', code: 'NO_SIGNER', message: 'no wallet' },
    });

    expect(await handleSubmitOperation(g, [{ operationRef: 'op-1' }])).toEqual({
      kind: 'REFUSED',
      code: 'NO_SIGNER',
      message: 'no wallet',
    });
  });

  it('treats a reply of the wrong kind as a failure rather than trusting it', async () => {
    const { gateway: g } = gateway({
      reply: { kind: 'pong', requestId: 'r1', protocolVersion: 1, uptimeSeconds: 1, schemaVersion: null },
    });

    expect(await handleSubmitOperation(g, [{ operationRef: 'op-1' }])).toMatchObject({
      kind: 'FAILED',
    });
  });
});
