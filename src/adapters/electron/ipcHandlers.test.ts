import { describe, expect, it, vi } from 'vitest';
import type { GetAppStatusDeps, WorkerProbe } from '../../app/getAppStatus';
import { loadConfig } from '../config/appConfig';
import { IPC_CHANNELS } from './ipcContract';
import {
  IpcPayloadError,
  assertNoPayload,
  handleGetAppStatus,
  pushWorkerHealth,
  registerIpcHandlers,
} from './ipcHandlers';

const RPC_WITH_KEY = 'https://sepolia.example.com/v2/PROJECT-KEY-DO-NOT-LEAK';

const deps = (worker: Partial<WorkerProbe> = {}): GetAppStatusDeps => ({
  publicConfig: loadConfig({
    env: { ZARYA_RPC_URL: RPC_WITH_KEY, ZARYA_MEMBER_KEY: '0xdeadbeef' },
    appVersion: '0.0.1-test',
  }).publicConfig,
  worker: {
    health: () => 'HEALTHY',
    probe: async () => ({ protocolVersion: 1, uptimeSeconds: 42 }),
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
    expect(status.worker).toEqual({ health: 'HEALTHY', protocolVersion: 1, uptimeSeconds: 42 });
    // Whatever else changes, the response must survive structured cloning.
    expect(() => structuredClone(status)).not.toThrow();
  });

  it('never carries a secret', async () => {
    const status = await handleGetAppStatus(deps());
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('PROJECT-KEY-DO-NOT-LEAK');
    expect(serialized).not.toContain('0xdeadbeef');
    expect(status.rpcHost).toBe('sepolia.example.com');
    expect(status.memberSignerConfigured).toBe(true);
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

  it('rejects a payload it was not supposed to receive', async () => {
    await expect(handleGetAppStatus(deps(), ['unexpected'])).rejects.toThrow(IpcPayloadError);
  });
});

describe('registerIpcHandlers', () => {
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

  it('registers exactly the channels in the contract', () => {
    const { handlers, ipcMain } = fakeIpcMain();
    registerIpcHandlers({ ipcMain, deps: deps() });
    expect([...handlers.keys()]).toEqual([IPC_CHANNELS.getAppStatus]);
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
    registerIpcHandlers({ ipcMain, deps: deps() });

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
});
