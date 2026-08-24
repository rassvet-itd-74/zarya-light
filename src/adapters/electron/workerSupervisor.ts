import {
  type WorkerHealth,
  type WorkerReply,
  type WorkerRequest,
  isWorkerReply,
} from './workerProtocol';

/**
 * Supervises the single background worker process.
 *
 * Three properties this owns, each of which is an invariant rather than a
 * nicety:
 *
 * - **One worker for the app's lifetime.** Closing and reopening a window must
 *   not fork a second one, or two transaction queues would eventually share one
 *   wallet nonce.
 * - **A restart triggers reconciliation, not a resumed timer.** Correctness must
 *   survive a process kill, so `onRestart` fires on every successful start
 *   including the first; Phase 7 wires `reconcile()` into it.
 * - **No orphans.** `stop()` cancels any pending restart before killing, so
 *   shutdown cannot race a backoff timer into spawning a worker as the app quits.
 *
 * The spawn function is injected so tests drive a fake process. Nothing here
 * imports `electron`; `createUtilityProcessSpawner` in `workerHost.ts` does.
 */

/** The slice of Electron's `UtilityProcess` this supervisor actually uses. */
export interface WorkerHandle {
  readonly pid: number | undefined;
  postMessage(message: WorkerRequest): void;
  on(event: 'spawn', listener: () => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  kill(): boolean;
}

export type SpawnWorker = () => WorkerHandle;

export interface WorkerSupervisorOptions {
  spawn: SpawnWorker;
  /** Called after every successful start. Phase 7 passes `reconcile`. */
  onRestart?: (reason: StartReason) => void;
  /** Reported but not thrown — a supervisor must not take the app down. */
  onError?: (error: Error) => void;
  maxRestartAttempts?: number;
  /** Backoff before restart attempt `attempt` (1-based). */
  backoffMs?: (attempt: number) => number;
  requestTimeoutMs?: number;
}

export type StartReason = 'initial' | 'restart';

const DEFAULT_MAX_RESTART_ATTEMPTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** 1s, 2s, 4s, 8s, capped at 30s. */
const defaultBackoffMs = (attempt: number): number =>
  Math.min(1_000 * 2 ** (attempt - 1), 30_000);

interface Pending {
  resolve: (reply: WorkerReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerSupervisor {
  private worker: WorkerHandle | undefined;
  private health: WorkerHealth = 'STOPPED';
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private nextRequestId = 1;

  private readonly pending = new Map<string, Pending>();
  private readonly healthListeners = new Set<(health: WorkerHealth) => void>();

  private readonly spawn: SpawnWorker;
  private readonly onRestart: (reason: StartReason) => void;
  private readonly onError: (error: Error) => void;
  private readonly maxRestartAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly requestTimeoutMs: number;

  constructor(options: WorkerSupervisorOptions) {
    this.spawn = options.spawn;
    this.onRestart = options.onRestart ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.maxRestartAttempts = options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  currentHealth(): WorkerHealth {
    return this.health;
  }

  isRunning(): boolean {
    return this.worker !== undefined;
  }

  /** Subscribe to health changes. Returns the unsubscribe function. */
  onHealthChange(listener: (health: WorkerHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  /**
   * Starts the worker if it is not already running. Idempotent by design — this
   * is what makes "one worker" hold when a window is recreated, rather than a
   * caller having to remember not to call twice.
   */
  start(reason: StartReason = 'initial'): void {
    if (this.stopping || this.worker !== undefined) return;

    this.setHealth('STARTING');

    let worker: WorkerHandle;
    try {
      worker = this.spawn();
    } catch (cause) {
      this.setHealth('DEGRADED');
      this.onError(
        new Error('failed to spawn the background worker', { cause }),
      );
      this.scheduleRestart();
      return;
    }

    this.worker = worker;

    worker.on('spawn', () => {
      // Only the worker we are currently tracking may report itself healthy; a
      // late event from a killed predecessor must not resurrect the state.
      if (this.worker !== worker) return;
      this.restartAttempts = 0;
      this.setHealth('HEALTHY');
      try {
        this.onRestart(reason);
      } catch (cause) {
        this.onError(new Error('worker start hook failed', { cause }));
      }
    });

    worker.on('message', (message: unknown) => {
      if (this.worker !== worker) return;
      this.receive(message);
    });

    worker.on('exit', (code: number) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.failAllPending(`worker exited with code ${code}`);

      if (this.stopping) {
        this.setHealth('STOPPED');
        return;
      }

      this.setHealth('DEGRADED');
      this.scheduleRestart();
    });
  }

  /**
   * Sends a request and resolves with the reply. Rejects on timeout rather than
   * hanging: an unanswered request is a degraded worker, and the caller needs to
   * be able to say so.
   */
  async request(kind: WorkerRequest['kind']): Promise<WorkerReply> {
    const worker = this.worker;
    if (worker === undefined) {
      throw new Error('the background worker is not running');
    }

    const requestId = `req-${this.nextRequestId++}`;
    return await new Promise<WorkerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.setHealth('DEGRADED');
        reject(new Error(`worker did not answer ${kind} within ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      try {
        worker.postMessage({ kind, requestId });
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('failed to send a request to the background worker', { cause }));
      }
    });
  }

  /**
   * Stops the worker and prevents any further restart. Called from `before-quit`.
   */
  stop(): void {
    this.stopping = true;
    this.cancelRestart();
    this.failAllPending('the application is shutting down');

    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) {
      try {
        worker.kill();
      } catch (cause) {
        this.onError(new Error('failed to stop the background worker', { cause }));
      }
    }
    this.setHealth('STOPPED');
  }

  private receive(message: unknown): void {
    if (!isWorkerReply(message)) {
      this.onError(new Error('discarded an unrecognized message from the worker'));
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (pending === undefined) {
      // A reply to a request that already timed out. Not an error worth
      // surfacing, but not something to hand to a resolved promise either.
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve(message);
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer !== undefined) return;

    this.restartAttempts += 1;
    if (this.restartAttempts > this.maxRestartAttempts) {
      this.setHealth('STOPPED');
      this.onError(
        new Error(
          `the background worker failed to stay up after ${this.maxRestartAttempts} attempts`,
        ),
      );
      return;
    }

    const delay = this.backoffMs(this.restartAttempts);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start('restart');
    }, delay);
    // Do not hold the process open just to retry.
    this.restartTimer.unref?.();
  }

  private cancelRestart(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private setHealth(health: WorkerHealth): void {
    if (this.health === health) return;
    this.health = health;
    for (const listener of this.healthListeners) {
      try {
        listener(health);
      } catch (cause) {
        this.onError(new Error('a worker health listener threw', { cause }));
      }
    }
  }
}
