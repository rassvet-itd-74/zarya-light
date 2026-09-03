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

import type { NetworkStatusView } from '../chain/networkStatusView';

export type { NetworkStatusView };

/** Bumped whenever a request or reply shape changes. */
export const WORKER_PROTOCOL_VERSION = 3;

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

/**
 * What a template issuance needs from the UI.
 *
 * The **destination path is chosen in main**, by a save dialog, and travels
 * inwards — so the bytes of a 330 KB document never cross the message port and
 * the worker owns both the record and the file. The renderer never sees a path it
 * did not get from that dialog.
 *
 * The organ arrives as a **subject code**, which is what a member reads off a
 * document, and becomes an ordinal only through the region table. There is no
 * numeric route from this message to a call argument, which is the point: the
 * two differ for 50 of 98 regions.
 */
export interface IssueTemplatePayload {
  readonly operationType: string;
  readonly organType?: string;
  readonly regionSubjectCode?: string;
  readonly organNumber?: number;
  readonly votingId?: string;
  readonly targetPath: string;
}

export type WorkerRequest =
  | { readonly kind: 'ping' | 'checkNetwork'; readonly requestId: string }
  | {
      readonly kind: 'issueTemplate';
      readonly requestId: string;
      readonly payload: IssueTemplatePayload;
    };

export type WorkerReply =
  | {
      readonly kind: 'pong';
      readonly requestId: string;
      readonly protocolVersion: number;
      readonly uptimeSeconds: number;
      /**
       * The local database's schema version, or `null` if it could not be opened.
       *
       * On `pong` rather than on a channel of its own because it answers the same
       * question — is this worker able to do work — and because a worker whose
       * store never opened is one whose issuance will fail on the first attempt.
       * Better said in the status readout than discovered at a save dialog.
       */
      readonly schemaVersion: number | null;
    }
  | {
      readonly kind: 'network';
      readonly requestId: string;
      readonly status: NetworkStatusView;
    }
  | {
      readonly kind: 'issued';
      readonly requestId: string;
      readonly operationRef: string;
      readonly path: string;
      readonly organIdentifier: string | null;
      readonly fieldCount: number;
    }
  | {
      /**
       * The application declined, with a reason. **Not** a `failure`: a refused
       * issuance recorded nothing and wrote nothing, and the user can fix it —
       * where a failure is an outage or a bug they cannot.
       */
      readonly kind: 'refused';
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: 'failure';
      readonly requestId: string;
      /** Safe for display: never a stack trace, never a configuration value. */
      readonly message: string;
    };

export type WorkerRequestKind = WorkerRequest['kind'];

/**
 * A request without its correlation id, which the supervisor assigns.
 *
 * Distributive on purpose — a plain `Omit` over a union collapses the arms and
 * would let `{ kind: 'issueTemplate' }` through with no payload, which is exactly
 * the mistake this type exists to prevent. Passing the whole shape rather than
 * `(kind, payload?)` means the compiler pairs each kind with what it needs.
 */
type Unaddressed<T> = T extends unknown ? Omit<T, 'requestId'> : never;

export type WorkerRequestSpec = Unaddressed<WorkerRequest>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasRequestId = (value: Record<string, unknown>): boolean =>
  typeof value.requestId === 'string' && value.requestId.length > 0;

const REQUEST_KINDS: ReadonlySet<string> = new Set(['ping', 'checkNetwork', 'issueTemplate']);

/**
 * Shape only, and shape is all this can promise.
 *
 * The *meaning* of an operation type or a subject code is checked in the worker
 * against the tables that own them — a guard here that knew the eleven operation
 * types would be a twelfth list to keep in step. What this refuses is a message
 * that could not have come from the preload surface we shipped.
 */
const isIssuePayload = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (typeof value.operationType !== 'string' || value.operationType.length === 0) return false;
  if (typeof value.targetPath !== 'string' || value.targetPath.length === 0) return false;
  for (const key of ['organType', 'regionSubjectCode', 'votingId'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (value.organNumber !== undefined && !Number.isSafeInteger(value.organNumber)) return false;
  return true;
};

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || !hasRequestId(value)) return false;
  if (typeof value.kind !== 'string' || !REQUEST_KINDS.has(value.kind)) return false;
  if (value.kind === 'issueTemplate') return isIssuePayload(value.payload);
  return true;
}

export function isWorkerReply(value: unknown): value is WorkerReply {
  if (!isRecord(value) || !hasRequestId(value)) return false;
  if (value.kind === 'pong') {
    return (
      typeof value.protocolVersion === 'number' &&
      typeof value.uptimeSeconds === 'number' &&
      (value.schemaVersion === null || typeof value.schemaVersion === 'number')
    );
  }
  if (value.kind === 'network') {
    return isRecord(value.status) && typeof value.status.status === 'string';
  }
  if (value.kind === 'issued') {
    return (
      typeof value.operationRef === 'string' &&
      typeof value.path === 'string' &&
      typeof value.fieldCount === 'number' &&
      (value.organIdentifier === null || typeof value.organIdentifier === 'string')
    );
  }
  if (value.kind === 'refused') {
    return typeof value.code === 'string' && typeof value.message === 'string';
  }
  if (value.kind === 'failure') {
    return typeof value.message === 'string';
  }
  return false;
}
