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
  /** Main → renderer, one-way push. */
  workerHealth: 'zarya:worker-health',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** The object exposed as `window.zarya`. Nothing else reaches the renderer. */
export interface ZaryaDesktopApi {
  getAppStatus(): Promise<AppStatus>;
  /** Subscribes to worker health pushes; returns the unsubscribe function. */
  onWorkerHealth(listener: (health: WorkerHealth) => void): () => void;
}

/**
 * The exposed key set, asserted by a test. Widening the renderer's surface is
 * then a deliberate two-place edit rather than an accident in one.
 */
export const ZARYA_API_KEYS = ['getAppStatus', 'onWorkerHealth'] as const;

export const ZARYA_API_GLOBAL = 'zarya';
