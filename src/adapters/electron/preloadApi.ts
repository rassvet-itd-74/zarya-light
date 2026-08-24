import {
  IPC_CHANNELS,
  type AppStatus,
  type ZaryaDesktopApi,
} from './ipcContract';
import { type WorkerHealth, isWorkerHealth } from './workerProtocol';

/**
 * Builds the object handed to the renderer through `contextBridge`.
 *
 * Separated from `preload.ts` so the exposed surface can be asserted in a test
 * without an Electron runtime — the thing worth pinning is *which* keys exist,
 * because every key is a capability the renderer gains permanently.
 */

/** The slice of `ipcRenderer` the preload surface uses. */
export interface RendererIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ): void;
}

export function createZaryaApi(ipc: RendererIpc): ZaryaDesktopApi {
  return {
    getAppStatus: async (): Promise<AppStatus> =>
      (await ipc.invoke(IPC_CHANNELS.getAppStatus)) as AppStatus,

    onWorkerHealth: (listener: (health: WorkerHealth) => void): (() => void) => {
      const subscription = (_event: unknown, ...args: unknown[]): void => {
        const [health] = args;
        // Pushes come from our own main process, but an unrecognized value here
        // would mean a stale renderer against a newer main. Dropping it beats
        // handing the UI a health state it has no rendering for.
        if (!isWorkerHealth(health)) return;
        listener(health);
      };

      ipc.on(IPC_CHANNELS.workerHealth, subscription);
      return () => {
        ipc.removeListener(IPC_CHANNELS.workerHealth, subscription);
      };
    },
  };
}
