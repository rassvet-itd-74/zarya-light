/**
 * The renderer's entire view of the application.
 *
 * Imported by preload, main, and the renderer, so it carries types and channel
 * names and nothing else. Purpose-specific channels only — no generic
 * `send(channel, payload)`, which would hand the renderer the whole IPC surface
 * and make the boundary unauditable (INVARIANTS.md, "Electron trust boundary").
 */

import type { AppStatus } from '../../app/getAppStatus';
import type { WorkerHealth } from './workerProtocol';

export type { AppStatus, WorkerHealth };

export const IPC_CHANNELS = {
  /** Renderer → main, invoke/handle. */
  getAppStatus: 'zarya:get-app-status',
  /** Renderer → main, invoke/handle. Opens a save dialog, then issues. */
  issueTemplate: 'zarya:issue-template',
  /** Main → renderer, one-way push. */
  workerHealth: 'zarya:worker-health',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * What the renderer asks for when a member wants a blank form.
 *
 * **No path.** The destination is chosen by a save dialog in main, and the
 * renderer neither proposes one nor learns anything about the filesystem it did
 * not already have. A renderer that could name a path could name any path.
 *
 * The organ arrives as a subject code because that is what a member reads off a
 * document. It becomes a region ordinal only in the worker, through the region
 * table.
 */
export interface IssueTemplateInput {
  readonly operationType: string;
  readonly organType?: string;
  readonly regionSubjectCode?: string;
  readonly organNumber?: number;
  readonly votingId?: string;
}

/**
 * Four outcomes, and they are kept apart because the UI owes the user a
 * different sentence for each.
 *
 * `CANCELLED` is not a failure — the user closed a save dialog, which is an
 * answer. `REFUSED` is the application declining something fixable, with a
 * reason. `FAILED` is an outage or a bug. Collapsing any two of these would
 * either alarm a user who simply changed their mind or reassure one whose
 * document was never written.
 */
export type IssueTemplateResult =
  | {
      readonly kind: 'ISSUED';
      readonly operationRef: string;
      readonly path: string;
      readonly organIdentifier: string | null;
      readonly fieldCount: number;
    }
  | { readonly kind: 'CANCELLED' }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: string }
  | { readonly kind: 'FAILED'; readonly message: string };

/** The object exposed as `window.zarya`. Nothing else reaches the renderer. */
export interface ZaryaDesktopApi {
  getAppStatus(): Promise<AppStatus>;
  /**
   * Asks for a blank form. Shows a save dialog, records the operation, writes
   * the file — or returns why it did not.
   */
  issueTemplate(input: IssueTemplateInput): Promise<IssueTemplateResult>;
  /** Subscribes to worker health pushes; returns the unsubscribe function. */
  onWorkerHealth(listener: (health: WorkerHealth) => void): () => void;
}

/**
 * The exposed key set, asserted by a test. Widening the renderer's surface is
 * then a deliberate two-place edit rather than an accident in one.
 */
export const ZARYA_API_KEYS = ['getAppStatus', 'issueTemplate', 'onWorkerHealth'] as const;

export const ZARYA_API_GLOBAL = 'zarya';
