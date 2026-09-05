import {
  IPC_CHANNELS,
  type AppStatus,
  type ImportFormResult,
  type SubmitOperationResult,
  type IssueTemplateInput,
  type IssueTemplateResult,
  type MatrixReportResult,
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

    issueTemplate: async (input: IssueTemplateInput): Promise<IssueTemplateResult> =>
      (await ipc.invoke(IPC_CHANNELS.issueTemplate, input)) as IssueTemplateResult,

    // No argument, because the report is not addressed. The handler asserts that
    // on arrival too — an extra argument there means the caller is not this
    // surface.
    generateMatrixReport: async (): Promise<MatrixReportResult> =>
      (await ipc.invoke(IPC_CHANNELS.generateMatrixReport)) as MatrixReportResult,

    // Also no argument: the file is chosen by a dialog in main, and a renderer
    // that could name a path could name any path — this one gets *read*.
    importForm: async (): Promise<ImportFormResult> =>
      (await ipc.invoke(IPC_CHANNELS.importForm)) as ImportFormResult,

    // The one call that can broadcast. It passes a reference and nothing else —
    // see `ZaryaDesktopApi.submitOperation` for why that is the whole of the
    // renderer's influence over what gets sent.
    submitOperation: async (input: {
      readonly operationRef: string;
    }): Promise<SubmitOperationResult> =>
      (await ipc.invoke(IPC_CHANNELS.submitOperation, input)) as SubmitOperationResult,

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
