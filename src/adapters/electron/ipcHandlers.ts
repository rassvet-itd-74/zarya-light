import type { IpcMain } from 'electron';
import { type AppStatus, type GetAppStatusDeps, getAppStatus } from '../../app/getAppStatus';
import { IPC_CHANNELS } from './ipcContract';
import type { WorkerHealth } from './workerProtocol';

/**
 * The receiving side of the IPC boundary.
 *
 * Two rules are enforced here rather than trusted:
 *
 * - **Payloads are validated on arrival.** The preload surface makes a malformed
 *   call awkward, not impossible — a compromised renderer talks to `ipcRenderer`
 *   directly. Renderer-side validation is UX; this is the trust boundary.
 * - **Errors are sanitized on the way out.** An error thrown inside
 *   `ipcMain.handle` is serialized to the renderer with its message and stack.
 *   Only messages we authored cross; anything else becomes a generic failure and
 *   the real error goes to the main-process reporter.
 *
 * Handler bodies are exported separately from registration so they can be tested
 * without an `ipcMain`.
 */

export class IpcPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcPayloadError';
  }
}

/**
 * A channel that takes no arguments must receive none. Extra arguments are not
 * harmless noise — they mean the caller is not the preload surface we shipped.
 */
export function assertNoPayload(channel: string, args: readonly unknown[]): void {
  if (args.length > 0) {
    throw new IpcPayloadError(`${channel} takes no arguments, received ${args.length}`);
  }
}

export async function handleGetAppStatus(
  deps: GetAppStatusDeps,
  args: readonly unknown[] = [],
): Promise<AppStatus> {
  assertNoPayload(IPC_CHANNELS.getAppStatus, args);
  return await getAppStatus(deps);
}

export interface RegisterIpcHandlersOptions {
  ipcMain: Pick<IpcMain, 'handle'>;
  deps: GetAppStatusDeps;
  /** Receives the unsanitized error. Never the renderer. */
  onError?: (channel: string, error: unknown) => void;
}

/**
 * Wraps a handler so only messages we wrote ourselves can reach the renderer.
 */
async function guarded<T>(
  channel: string,
  onError: (channel: string, error: unknown) => void,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    onError(channel, error);
    if (error instanceof IpcPayloadError) {
      throw new Error(error.message);
    }
    throw new Error(`${channel} failed`);
  }
}

export function registerIpcHandlers({
  ipcMain,
  deps,
  onError = () => undefined,
}: RegisterIpcHandlersOptions): void {
  ipcMain.handle(IPC_CHANNELS.getAppStatus, async (_event, ...args: unknown[]) =>
    await guarded(IPC_CHANNELS.getAppStatus, onError, () => handleGetAppStatus(deps, args)),
  );
}

/** Minimal shape of what a health push needs — a window's `webContents`. */
export interface HealthPushTarget {
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: WorkerHealth) => void;
}

/**
 * Pushes worker health to every live window. Destroyed windows are skipped
 * rather than guarded against by the caller: health changes arrive
 * asynchronously and a window can close between the change and the push.
 */
export function pushWorkerHealth(
  targets: readonly HealthPushTarget[],
  health: WorkerHealth,
): void {
  for (const target of targets) {
    if (target.isDestroyed()) continue;
    target.send(IPC_CHANNELS.workerHealth, health);
  }
}
