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
  /** Renderer → main, invoke/handle. Opens a save dialog, then reads the matrix. */
  generateMatrixReport: 'zarya:generate-matrix-report',
  /** Renderer → main, invoke/handle. Opens a file dialog, then imports what it names. */
  importForm: 'zarya:import-form',
  submitOperation: 'zarya:submit-operation',
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

/**
 * What a finished matrix report tells the UI.
 *
 * The counts are here so the panel can say something truthful about a document
 * the user cannot see from the app. `degradedRows` in particular: a report can
 * be written *and* incomplete, and a row whose fields did not read is marked on
 * the page — so the UI has to be able to point at it rather than reporting an
 * unqualified success.
 *
 * `blockNumber` is a decimal string for the same reason it is one in the worker
 * protocol: a `bigint` does not survive the structured clone, and nothing here
 * does arithmetic on it.
 */
export type MatrixReportResult =
  | {
      readonly kind: 'REPORTED';
      readonly path: string;
      readonly pageCount: number;
      readonly blockNumber: string;
      /** The pinned block's own timestamp, in seconds. Chain time. */
      readonly readAt: number;
      readonly rows: number;
      readonly degradedRows: number;
      readonly empty: boolean;
    }
  | { readonly kind: 'CANCELLED' }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: string }
  | { readonly kind: 'FAILED'; readonly message: string };

/**
 * What a finished import tells the UI.
 *
 * `fields` is the intent flattened to strings, and it is what a member checks
 * before anything is submitted — the form is untrusted, so seeing what the
 * application actually understood is the point of the screen rather than a
 * courtesy.
 *
 * `warnings` is tamper evidence and must be shown even though the import
 * succeeded: a context field edited in the file, or a field whose appearance
 * disagreed with its value. Neither can change the intent, which is exactly why
 * neither may be silently dropped.
 */
export type ImportFormResult =
  | {
      readonly kind: 'IMPORTED';
      readonly operationRef: string;
      readonly operationType: string;
      readonly fields: readonly { readonly label: string; readonly value: string }[];
      readonly warnings: readonly {
        readonly code: string;
        readonly field?: string;
        readonly message: string;
      }[];
    }
  | { readonly kind: 'CANCELLED' }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: string }
  | { readonly kind: 'FAILED'; readonly message: string };

/**
 * What sending an operation tells the UI.
 *
 * `SENT` carries every attempt, and `partial` says whether the rest of a
 * multi-call operation followed. A threshold configuration is three transactions
 * with no atomicity across them, so "some of it happened" is a real outcome and
 * not an error state — presenting it as a failure would tell a member nothing
 * was done when an organ is already half configured.
 *
 * `DECLINED` is the user answering no at the confirmation. Distinct from
 * `REFUSED`, which is the application declining, and from `CANCELLED`, which
 * other calls use for a dismissed file dialog — a member who read what was about
 * to be sent and said no has done something deliberate.
 */
export type SubmitOperationResult =
  | {
      readonly kind: 'SENT';
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
  | { readonly kind: 'DECLINED' }
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
  /**
   * Asks for the coordinate reference. Shows a save dialog, projects the
   * matrix's whole event history, reads every cell at one pinned block, and
   * writes the document — or returns why it did not.
   *
   * **Slow by nature** compared with every other call here, and unbounded in a
   * way they are not: the work grows with the chain's height and with the number
   * of populated coordinates. Roughly a second against Sepolia's empty matrix on
   * 2026-09-05, which is a floor rather than a typical figure. A caller must keep
   * its button disabled for the whole wait; there is no progress channel yet.
   */
  generateMatrixReport(): Promise<MatrixReportResult>;
  /**
   * Imports a filled form. Shows a file dialog, reads the file, recovers the
   * app-authored half from the local record, and returns what the application
   * understood — or why it will not.
   *
   * Takes no argument: a renderer that could name a path could name any path,
   * and the file is chosen in main.
   */
  importForm(): Promise<ImportFormResult>;
  /**
   * Sends an imported operation. **The only call here that broadcasts.**
   *
   * Takes an `operationRef` and nothing else. It names *which* stored operation
   * to send; it cannot influence *what* that operation is, because the worker
   * derives that by re-reading the document stored with the record. A renderer
   * that could pass calldata, an address or an amount would be inside the form
   * pipeline's allow-list.
   *
   * Main asks for confirmation before anything is signed. That is a guard
   * against a mis-click, not against a compromised renderer — a renderer that
   * wanted to send could call this with any reference it liked, and the
   * confirmation would name that one.
   */
  submitOperation(input: { readonly operationRef: string }): Promise<SubmitOperationResult>;
  /** Subscribes to worker health pushes; returns the unsubscribe function. */
  onWorkerHealth(listener: (health: WorkerHealth) => void): () => void;
}

/**
 * The exposed key set, asserted by a test. Widening the renderer's surface is
 * then a deliberate two-place edit rather than an accident in one.
 */
export const ZARYA_API_KEYS = [
  'getAppStatus',
  'issueTemplate',
  'generateMatrixReport',
  'importForm',
  'submitOperation',
  'onWorkerHealth',
] as const;

export const ZARYA_API_GLOBAL = 'zarya';
