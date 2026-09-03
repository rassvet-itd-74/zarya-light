import type { IpcMain } from 'electron';
import { type AppStatus, type GetAppStatusDeps, getAppStatus } from '../../app/getAppStatus';
import {
  IPC_CHANNELS,
  type IssueTemplateInput,
  type IssueTemplateResult,
} from './ipcContract';
import type { IssueTemplatePayload, WorkerHealth, WorkerReply } from './workerProtocol';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The first of two validations this payload gets.
 *
 * Shape only. The *meaning* of an operation type or a subject code is checked in
 * the worker against the tables that own them, because a guard here that knew the
 * eleven operation types would be another list to keep in step with the intent
 * model. What this refuses is a message that could not have come from the preload
 * surface we shipped — which is the case that matters, since a compromised
 * renderer talks to `ipcRenderer` directly and never touches our preload at all.
 */
export function parseIssueTemplateInput(args: readonly unknown[]): IssueTemplateInput {
  if (args.length !== 1) {
    throw new IpcPayloadError(
      `${IPC_CHANNELS.issueTemplate} takes one argument, received ${args.length}`,
    );
  }
  const [payload] = args;
  if (!isRecord(payload)) {
    throw new IpcPayloadError(`${IPC_CHANNELS.issueTemplate} takes an object`);
  }
  if (typeof payload.operationType !== 'string' || payload.operationType.length === 0) {
    throw new IpcPayloadError('an issuance must name an operation type');
  }

  for (const key of ['organType', 'regionSubjectCode', 'votingId'] as const) {
    const value = payload[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > 64)) {
      throw new IpcPayloadError(`${key} must be a short string`);
    }
  }
  // Bounded rather than merely integral: `organNumber` is rendered decimally into
  // an organ identifier and has to round-trip exactly, so a value past the safe
  // range would hash to a different organ than the one displayed.
  if (
    payload.organNumber !== undefined &&
    (typeof payload.organNumber !== 'number' ||
      !Number.isSafeInteger(payload.organNumber) ||
      payload.organNumber < 0)
  ) {
    throw new IpcPayloadError('organNumber must be a non-negative safe integer');
  }

  // Rebuilt rather than passed through, so a field nobody validated cannot ride
  // along into the worker.
  return {
    operationType: payload.operationType,
    ...(payload.organType === undefined ? {} : { organType: payload.organType as string }),
    ...(payload.regionSubjectCode === undefined
      ? {}
      : { regionSubjectCode: payload.regionSubjectCode as string }),
    ...(payload.organNumber === undefined
      ? {}
      : { organNumber: payload.organNumber as number }),
    ...(payload.votingId === undefined ? {} : { votingId: payload.votingId as string }),
  };
}

/**
 * Chooses a destination, then asks the worker to issue.
 *
 * The save dialog is here and not in the worker because it belongs to the window,
 * and it runs **before** any work: a cancelled dialog must leave no row and no
 * file, and the cheapest way to guarantee that is to have nothing to undo.
 *
 * `IssueTemplateGateway` is a port in all but name — it is what keeps this
 * function testable without an Electron dialog or a live worker.
 */
export interface IssueTemplateGateway {
  /** `null` when the user cancelled. */
  chooseDestination(suggestedName: string): Promise<string | null>;
  issue(payload: IssueTemplatePayload): Promise<WorkerReply>;
}

export async function handleIssueTemplate(
  gateway: IssueTemplateGateway,
  args: readonly unknown[],
): Promise<IssueTemplateResult> {
  const input = parseIssueTemplateInput(args);

  const target = await gateway.chooseDestination(suggestedFileName(input.operationType));
  if (target === null) return { kind: 'CANCELLED' };

  const reply = await gateway.issue({ ...input, targetPath: target });

  switch (reply.kind) {
    case 'issued':
      return {
        kind: 'ISSUED',
        operationRef: reply.operationRef,
        path: reply.path,
        organIdentifier: reply.organIdentifier,
        fieldCount: reply.fieldCount,
      };
    case 'refused':
      return { kind: 'REFUSED', code: reply.code, message: reply.message };
    case 'failure':
      return { kind: 'FAILED', message: reply.message };
    default:
      // A reply of the wrong kind means a version skew between main and a stale
      // worker build. Reported as a failure rather than trusted.
      return { kind: 'FAILED', message: `the worker answered with ${reply.kind}` };
  }
}

/**
 * A filename a member can recognise in a downloads folder.
 *
 * Lower-cased and hyphenated from the operation type rather than from a Russian
 * label: this is a filename, it crosses filesystems and email, and a Cyrillic one
 * survives that badly. The document itself is Russian throughout.
 */
export const suggestedFileName = (operationType: string): string =>
  `zarya-${operationType.toLowerCase().replace(/_/g, '-')}.pdf`;

export interface RegisterIpcHandlersOptions {
  ipcMain: Pick<IpcMain, 'handle'>;
  deps: GetAppStatusDeps;
  issuance: IssueTemplateGateway;
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
  issuance,
  onError = () => undefined,
}: RegisterIpcHandlersOptions): void {
  ipcMain.handle(IPC_CHANNELS.getAppStatus, async (_event, ...args: unknown[]) =>
    await guarded(IPC_CHANNELS.getAppStatus, onError, () => handleGetAppStatus(deps, args)),
  );

  ipcMain.handle(IPC_CHANNELS.issueTemplate, async (_event, ...args: unknown[]) =>
    await guarded(IPC_CHANNELS.issueTemplate, onError, () =>
      handleIssueTemplate(issuance, args),
    ),
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
 *
 * ## `isDestroyed()` is not enough, which a real run showed
 *
 * A window can report itself alive while its **render frame** is already gone,
 * and `send` then throws `Render frame was disposed before WebFrameMain could be
 * accessed`. It happens at both ends of a window's life: the worker reports
 * `HEALTHY` before the first frame has committed, and again on the way out.
 *
 * The throw is swallowed because this push is **best-effort UI**, not a delivery
 * guarantee — the renderer reads the same health from `getAppStatus` whenever it
 * refreshes, so a missed push costs nothing and a thrown one would propagate out
 * of a supervisor event handler with no caller to catch it.
 */
export function pushWorkerHealth(
  targets: readonly HealthPushTarget[],
  health: WorkerHealth,
): void {
  for (const target of targets) {
    if (target.isDestroyed()) continue;
    try {
      target.send(IPC_CHANNELS.workerHealth, health);
    } catch {
      // A window that went away between the check and the send. Not an error
      // anyone can act on, and not worth a log line on every shutdown.
    }
  }
}
