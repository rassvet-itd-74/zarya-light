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
export const WORKER_PROTOCOL_VERSION = 7;

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

/**
 * What a matrix report needs from the UI, which is a destination and nothing
 * else.
 *
 * There is no operation type, no organ and no coordinate range, because a report
 * is not addressed: it is the whole matrix as of one block. Everything that
 * decides its content — which blocks to project, which block to pin — is read
 * from the chain and the configuration inside the worker, so there is no field
 * here a renderer could set to change what the document says.
 */
export interface MatrixReportPayload {
  readonly targetPath: string;
}

export type WorkerRequest =
  | { readonly kind: 'ping' | 'checkNetwork'; readonly requestId: string }
  | {
      readonly kind: 'issueTemplate';
      readonly requestId: string;
      readonly payload: IssueTemplatePayload;
    }
  | {
      readonly kind: 'generateMatrixReport';
      readonly requestId: string;
      readonly payload: MatrixReportPayload;
    }
  | {
      readonly kind: 'importForm';
      readonly requestId: string;
      readonly payload: ImportFormPayload;
    }
  | {
      readonly kind: 'submitOperation';
      readonly requestId: string;
      readonly payload: SubmitOperationPayload;
    }
  | {
      readonly kind: 'useMemberKey';
      readonly requestId: string;
      readonly payload: MemberKeyPayload;
    };

/**
 * The member wallet's key, travelling from main to the worker exactly once per
 * worker start.
 *
 * **This is the only message in the protocol that carries a secret**, and every
 * choice about it is a consequence of that.
 *
 * *Why it travels at all.* `safeStorage` is a main-process API — Electron
 * declares it in `Main` and not in `Utility` — so a `utilityProcess` cannot
 * decrypt anything. Signing lives in the worker with the store and the chain
 * client. One of those two facts has to give, and moving the key is cheaper than
 * moving the queue.
 *
 * *Why not the environment.* The RPC URL is passed that way at fork, and a key
 * is not the same thing: an environment is inherited by any child a process
 * spawns and is readable from outside the process on several platforms. A
 * message is delivered once, to one recipient, and leaves nothing behind.
 *
 * *Where it must never go.* Not to the renderer, not to a log line, not to the
 * database (hard rule 2). The worker holds it in a module-local and hands it to
 * a signer built per request.
 */
export interface MemberKeyPayload {
  readonly privateKey: string;
}

/**
 * What sending an operation needs from the UI: **which** one, and nothing else.
 *
 * This is the only message in the protocol that leads to a transaction, so what
 * it does *not* carry is the important part. No intent, no calldata, no address,
 * no amount, no signer. The renderer names a stored operation and the worker
 * derives what that means by re-reading the document stored with it.
 *
 * A payload that could carry calldata would put the untrusted UI inside the
 * allow-list the whole form pipeline exists to enforce — one layer below where
 * anyone would think to look for a hole.
 */
export interface SubmitOperationPayload {
  readonly operationRef: string;
}

/**
 * What an import needs from the UI: where the file is, and nothing else.
 *
 * The path travels **inwards** only, exactly as issuance's destination does, and
 * it comes from an open dialog in main. A renderer that could name a path could
 * name any path, and this one is read.
 *
 * Nothing else crosses because nothing else may: which operation the form
 * belongs to is the file's to state and the record's to confirm, and a caller
 * that could assert an `operationRef` here would be supplying the app-authored
 * half from outside the record (hard rule 4).
 */
export interface ImportFormPayload {
  readonly sourcePath: string;
}

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
      readonly kind: 'reported';
      readonly requestId: string;
      readonly path: string;
      readonly pageCount: number;
      /**
       * The block every row was read at, as a decimal string.
       *
       * A string because a `bigint` does not survive `postMessage`'s structured
       * clone in every Electron build, and because nothing downstream does
       * arithmetic on it — it is displayed, and it is what the page is stamped
       * with.
       */
      readonly blockNumber: string;
      /** The pinned block's own timestamp, in seconds. Chain time, never the workstation's. */
      readonly readAt: number;
      readonly rows: number;
      readonly degradedRows: number;
      readonly empty: boolean;
    }
  | {
      readonly kind: 'imported';
      readonly requestId: string;
      readonly operationRef: string;
      readonly operationType: string;
      /**
       * The intent, flattened to strings by `describeIntent`.
       *
       * Flattened because a `bigint` does not cross a structured clone reliably,
       * and a coordinate or a scaled value that arrived coerced would describe a
       * different cell or a different number. Nothing downstream reconstructs an
       * intent from this — it is for a person to read.
       */
      readonly fields: readonly { readonly label: string; readonly value: string }[];
      /** Context edited in the file, or an appearance that disagrees with its value. */
      readonly warnings: readonly {
        readonly code: string;
        readonly field?: string;
        readonly message: string;
      }[];
    }
  | {
      /**
       * One or more transactions left this machine.
       *
       * `partial` is its own field rather than a second reply kind because the
       * difference matters to a reader and not to a parser: a threshold
       * configuration is three transactions with no atomicity across them, so
       * some may have landed and then one failed. A caller must never present
       * that as "nothing happened", which is why the attempts are listed either
       * way and why the message survives beside them.
       */
      readonly kind: 'submitted';
      readonly requestId: string;
      readonly operationRef: string;
      readonly partial: boolean;
      readonly attempts: readonly {
        readonly attemptId: string;
        readonly hash: string;
        readonly nonce: number;
      }[];
      /** Present only when `partial`: what stopped the rest. */
      readonly message?: string;
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
      /**
       * The worker has a wallet and will sign with this address.
       *
       * The **address** comes back, never the key. It is what the status readout
       * shows and what a member funds.
       */
      readonly kind: 'signerReady';
      readonly requestId: string;
      readonly address: string;
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

const REQUEST_KINDS: ReadonlySet<string> = new Set([
  'ping',
  'checkNetwork',
  'issueTemplate',
  'generateMatrixReport',
  'importForm',
  'submitOperation',
  'useMemberKey',
]);

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

/** A destination and nothing else, so there is exactly one field to check. */
const isReportPayload = (value: unknown): boolean =>
  isRecord(value) && typeof value.targetPath === 'string' && value.targetPath.length > 0;

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || !hasRequestId(value)) return false;
  if (typeof value.kind !== 'string' || !REQUEST_KINDS.has(value.kind)) return false;
  if (value.kind === 'issueTemplate') return isIssuePayload(value.payload);
  if (value.kind === 'generateMatrixReport') return isReportPayload(value.payload);
  if (value.kind === 'importForm') return isImportPayload(value.payload);
  if (value.kind === 'submitOperation') return isSubmitPayload(value.payload);
  if (value.kind === 'useMemberKey') return isMemberKeyPayload(value.payload);
  return true;
}

/**
 * Shape only, and the shape is checked rather than the value.
 *
 * A guard that validated the key would have to look at it, and the one place
 * this message is allowed to be examined is the signer that uses it. The worker
 * discovers a malformed key by failing to build an account, which is a refusal a
 * member can be told about without anything being echoed.
 */
const isMemberKeyPayload = (value: unknown): boolean =>
  isRecord(value) && typeof value.privateKey === 'string' && value.privateKey.length > 0;

/**
 * One reference and nothing else.
 *
 * The narrowest payload in the protocol, and deliberately so: this is the message
 * that leads to a transaction, and the surface a malformed one could exploit is
 * exactly the surface this guard describes.
 */
const isSubmitPayload = (value: unknown): boolean =>
  isRecord(value) && typeof value.operationRef === 'string' && value.operationRef.length > 0;

/** A source path and nothing else, so there is exactly one field to check. */
const isImportPayload = (value: unknown): boolean =>
  isRecord(value) && typeof value.sourcePath === 'string' && value.sourcePath.length > 0;

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
  if (value.kind === 'reported') {
    return (
      typeof value.path === 'string' &&
      typeof value.pageCount === 'number' &&
      // Never a bigint: it crossed as a decimal string, and a bigint arriving
      // here would mean a worker built against a different protocol.
      typeof value.blockNumber === 'string' &&
      typeof value.readAt === 'number' &&
      typeof value.rows === 'number' &&
      typeof value.degradedRows === 'number' &&
      typeof value.empty === 'boolean'
    );
  }
  if (value.kind === 'signerReady') {
    return typeof value.address === 'string' && value.address.length > 0;
  }
  if (value.kind === 'submitted') {
    return (
      typeof value.operationRef === 'string' &&
      typeof value.partial === 'boolean' &&
      Array.isArray(value.attempts) &&
      value.attempts.every(
        (attempt: unknown) =>
          isRecord(attempt) &&
          typeof attempt.attemptId === 'string' &&
          // A hash is a string here for the same reason a block number is: it is
          // displayed and compared, never used for arithmetic.
          typeof attempt.hash === 'string' &&
          Number.isSafeInteger(attempt.nonce),
      ) &&
      (value.message === undefined || typeof value.message === 'string')
    );
  }
  if (value.kind === 'imported') {
    return (
      typeof value.operationRef === 'string' &&
      typeof value.operationType === 'string' &&
      Array.isArray(value.fields) &&
      // Every value a string: a `bigint` or a `number` arriving here would mean a
      // worker that skipped `describeIntent`, and a coordinate read as a number
      // addresses a different cell.
      value.fields.every(
        (field: unknown) =>
          isRecord(field) &&
          typeof field.label === 'string' &&
          typeof field.value === 'string',
      ) &&
      Array.isArray(value.warnings)
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
