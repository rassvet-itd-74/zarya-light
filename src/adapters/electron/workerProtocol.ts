/**
 * The main ↔ worker message protocol.
 *
 * Types and pure guards only: this module is imported by the main process, by
 * the worker, and — for its `WorkerHealth` type — by the preload and renderer,
 * so it must pull in nothing at all.
 *
 * Every message is validated on arrival at both ends. The worker is a child of
 * our own main process rather than untrusted input, but a message that fails to
 * match is evidence of a version skew between a stale build and a fresh one, and
 * a clear rejection beats a `TypeError` three frames deep.
 */

export const WORKER_PROTOCOL_VERSION = 1;

/**
 * Liveness of the worker **process**. Not executor health: a healthy worker can
 * still report a degraded executor, and a rejected voting is a governance
 * outcome rather than a fault (DECISIONS.md). Phase 7 layers executor health on
 * top of this.
 */
export const WORKER_HEALTH_VALUES = [
  'STARTING',
  'HEALTHY',
  'DEGRADED',
  'STOPPED',
] as const;

export type WorkerHealth = (typeof WORKER_HEALTH_VALUES)[number];

export function isWorkerHealth(value: unknown): value is WorkerHealth {
  return (
    typeof value === 'string' &&
    (WORKER_HEALTH_VALUES as readonly string[]).includes(value)
  );
}

export type WorkerRequest = {
  readonly kind: 'ping';
  readonly requestId: string;
};

export type WorkerReply =
  | {
      readonly kind: 'pong';
      readonly requestId: string;
      readonly protocolVersion: number;
      readonly uptimeSeconds: number;
    }
  | {
      readonly kind: 'failure';
      readonly requestId: string;
      /** Safe for display: never a stack trace, never a configuration value. */
      readonly message: string;
    };

export type WorkerRequestKind = WorkerRequest['kind'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasRequestId = (value: Record<string, unknown>): boolean =>
  typeof value.requestId === 'string' && value.requestId.length > 0;

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  return isRecord(value) && hasRequestId(value) && value.kind === 'ping';
}

export function isWorkerReply(value: unknown): value is WorkerReply {
  if (!isRecord(value) || !hasRequestId(value)) return false;
  if (value.kind === 'pong') {
    return (
      typeof value.protocolVersion === 'number' &&
      typeof value.uptimeSeconds === 'number'
    );
  }
  if (value.kind === 'failure') {
    return typeof value.message === 'string';
  }
  return false;
}
