import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, ZARYA_API_KEYS } from './ipcContract';
import { type RendererIpc, createZaryaApi } from './preloadApi';

const fakeIpc = () => {
  const listeners = new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>();
  const invoke = vi.fn(async () => ({ ok: true }));
  const ipc: RendererIpc = {
    invoke,
    on: (channel, listener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    },
    removeListener: (channel, listener) => {
      listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== listener));
    },
  };
  const emit = (channel: string, payload: unknown): void => {
    for (const listener of listeners.get(channel) ?? []) listener(null, payload);
  };
  return { ipc, invoke, listeners, emit };
};

describe('the renderer surface', () => {
  // Every key here is a capability the UI holds permanently. Widening it should
  // be a deliberate two-place edit, not a one-line accident.
  it('exposes exactly the declared keys', () => {
    const api = createZaryaApi(fakeIpc().ipc);
    expect(Object.keys(api).sort()).toEqual([...ZARYA_API_KEYS].sort());
  });

  it('does not hand the renderer a raw send or an ipc object', () => {
    const api = createZaryaApi(fakeIpc().ipc) as unknown as Record<string, unknown>;
    for (const forbidden of ['send', 'invoke', 'ipcRenderer', 'on', 'sendSync', 'postMessage']) {
      expect(api[forbidden]).toBeUndefined();
    }
  });
});

describe('getAppStatus', () => {
  it('invokes its own channel with no arguments', async () => {
    const { ipc, invoke } = fakeIpc();
    await createZaryaApi(ipc).getAppStatus();
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.getAppStatus);
  });
});

describe('onWorkerHealth', () => {
  it('delivers a known health value', () => {
    const { ipc, emit } = fakeIpc();
    const seen: string[] = [];
    createZaryaApi(ipc).onWorkerHealth((health) => seen.push(health));

    emit(IPC_CHANNELS.workerHealth, 'DEGRADED');
    expect(seen).toEqual(['DEGRADED']);
  });

  it('drops a value it has no rendering for', () => {
    const { ipc, emit } = fakeIpc();
    const seen: string[] = [];
    createZaryaApi(ipc).onWorkerHealth((health) => seen.push(health));

    // A stale renderer against a newer main. Dropping beats forwarding a state
    // the UI cannot display.
    emit(IPC_CHANNELS.workerHealth, 'EXPLODED');
    emit(IPC_CHANNELS.workerHealth, undefined);
    emit(IPC_CHANNELS.workerHealth, { health: 'HEALTHY' });
    expect(seen).toEqual([]);
  });

  it('unsubscribes', () => {
    const { ipc, emit, listeners } = fakeIpc();
    const seen: string[] = [];
    const unsubscribe = createZaryaApi(ipc).onWorkerHealth((health) => seen.push(health));

    unsubscribe();
    emit(IPC_CHANNELS.workerHealth, 'HEALTHY');

    expect(seen).toEqual([]);
    expect(listeners.get(IPC_CHANNELS.workerHealth)).toEqual([]);
  });
});
