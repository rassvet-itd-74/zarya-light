import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKER_PROTOCOL_VERSION, type WorkerRequest } from './workerProtocol';
import {
  type StartReason,
  type WorkerHandle,
  WorkerSupervisor,
} from './workerSupervisor';

type Listener = (...args: never[]) => void;

/** Stands in for Electron's UtilityProcess. */
class FakeWorker implements WorkerHandle {
  readonly pid = 4242;
  readonly sent: WorkerRequest[] = [];
  killed = false;

  private readonly listeners = new Map<string, Listener[]>();

  on(event: 'spawn' | 'exit' | 'message', listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }

  spawned(): void {
    this.emit('spawn');
  }

  exited(code = 1): void {
    this.emit('exit', code);
  }

  replied(message: unknown): void {
    this.emit('message', message);
  }

  /** Answers the last request as the real worker would. */
  pong(uptimeSeconds = 7): void {
    const last = this.sent.at(-1);
    if (last === undefined) throw new Error('nothing was sent');
    this.replied({
      kind: 'pong',
      requestId: last.requestId,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      uptimeSeconds,
    });
  }
}

const harness = () => {
  const workers: FakeWorker[] = [];
  const restarts: StartReason[] = [];
  const errors: string[] = [];

  const supervisor = new WorkerSupervisor({
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    onRestart: (reason) => restarts.push(reason),
    onError: (error) => errors.push(error.message),
    backoffMs: () => 1_000,
    maxRestartAttempts: 3,
    requestTimeoutMs: 5_000,
  });

  return { supervisor, workers, restarts, errors, latest: () => workers.at(-1) as FakeWorker };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('starting', () => {
  it('reports STARTING then HEALTHY, and runs the start hook once spawned', () => {
    const { supervisor, restarts, latest } = harness();
    const seen: string[] = [];
    supervisor.onHealthChange((health) => seen.push(health));

    supervisor.start();
    // STARTING, not HEALTHY: the process exists but has not reported in.
    expect(supervisor.currentHealth()).toBe('STARTING');
    expect(restarts).toEqual([]);

    latest().spawned();

    expect(supervisor.currentHealth()).toBe('HEALTHY');
    expect(seen).toEqual(['STARTING', 'HEALTHY']);
  });

  // The invariant: two windows, or a window closed and reopened, must never
  // mean two workers — a second transaction queue would share one wallet nonce.
  it('is idempotent: repeated starts fork one worker', () => {
    const { supervisor, workers } = harness();
    supervisor.start();
    supervisor.start();
    supervisor.start();
    expect(workers).toHaveLength(1);
  });

  it('calls the start hook on the first start, not only on restarts', () => {
    const { supervisor, restarts, latest } = harness();
    supervisor.start();
    latest().spawned();
    // Startup reconciliation is the same path as restart reconciliation.
    expect(restarts).toEqual(['initial']);
  });
});

describe('crash and restart', () => {
  it('degrades on exit, then restarts after the backoff and reconciles again', () => {
    const { supervisor, workers, restarts, latest } = harness();
    supervisor.start();
    latest().spawned();

    latest().exited(9);
    expect(supervisor.currentHealth()).toBe('DEGRADED');
    expect(supervisor.isRunning()).toBe(false);
    expect(workers).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(workers).toHaveLength(2);

    latest().spawned();
    expect(supervisor.currentHealth()).toBe('HEALTHY');
    // The hook fires again — recovery is reconciliation, never a resumed timer.
    expect(restarts).toEqual(['initial', 'restart']);
  });

  it('gives up after the attempt limit and says so', () => {
    const { supervisor, errors, latest } = harness();
    supervisor.start();
    latest().spawned();

    // Three failures are allowed; the fourth exit stops trying.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      latest().exited();
      vi.advanceTimersByTime(1_000);
    }

    expect(supervisor.currentHealth()).toBe('STOPPED');
    expect(errors.some((message) => message.includes('failed to stay up'))).toBe(true);
  });

  it('resets the attempt count once a worker stays up', () => {
    const { supervisor, workers, latest } = harness();
    supervisor.start();
    latest().spawned();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      latest().exited();
      vi.advanceTimersByTime(1_000);
      latest().spawned();
    }

    // Five spawns would have exceeded maxRestartAttempts had it not reset.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      latest().exited();
      vi.advanceTimersByTime(1_000);
      latest().spawned();
    }

    expect(supervisor.currentHealth()).toBe('HEALTHY');
    expect(workers).toHaveLength(6);
  });

  it('ignores events from a worker it no longer tracks', () => {
    const { supervisor, latest } = harness();
    supervisor.start();
    const first = latest();
    first.spawned();

    first.exited();
    vi.advanceTimersByTime(1_000);
    const second = latest();
    second.spawned();

    // A late event from the dead predecessor must not move the state.
    first.exited();
    expect(supervisor.currentHealth()).toBe('HEALTHY');
    expect(supervisor.isRunning()).toBe(true);
    expect(second.killed).toBe(false);
  });

  it('reports a spawn failure and retries rather than throwing', () => {
    const failing = new WorkerSupervisor({
      spawn: () => {
        throw new Error('ENOENT');
      },
      onError: () => undefined,
      backoffMs: () => 1_000,
      maxRestartAttempts: 1,
    });

    expect(() => failing.start()).not.toThrow();
    expect(failing.currentHealth()).toBe('DEGRADED');
    vi.advanceTimersByTime(1_000);
    expect(failing.currentHealth()).toBe('STOPPED');
  });
});

describe('requests', () => {
  it('resolves with the matching reply', async () => {
    const { supervisor, latest } = harness();
    supervisor.start();
    latest().spawned();

    const pending = supervisor.request('ping');
    expect(latest().sent).toHaveLength(1);
    latest().pong(11);

    await expect(pending).resolves.toMatchObject({
      kind: 'pong',
      protocolVersion: WORKER_PROTOCOL_VERSION,
      uptimeSeconds: 11,
    });
  });

  it('rejects and degrades when the worker does not answer', async () => {
    const { supervisor, latest } = harness();
    supervisor.start();
    latest().spawned();

    const pending = supervisor.request('ping');
    vi.advanceTimersByTime(5_000);

    await expect(pending).rejects.toThrow('did not answer');
    expect(supervisor.currentHealth()).toBe('DEGRADED');
  });

  it('discards a reply that does not match the protocol', async () => {
    const { supervisor, errors, latest } = harness();
    supervisor.start();
    latest().spawned();

    const pending = supervisor.request('ping');
    latest().replied({ kind: 'pong' });
    latest().replied('nonsense');
    vi.advanceTimersByTime(5_000);

    await expect(pending).rejects.toThrow('did not answer');
    expect(errors.some((message) => message.includes('unrecognized message'))).toBe(true);
  });

  it('fails a pending request when the worker exits', async () => {
    const { supervisor, latest } = harness();
    supervisor.start();
    latest().spawned();

    const pending = supervisor.request('ping');
    latest().exited();

    await expect(pending).rejects.toThrow('worker exited');
  });

  it('refuses to send when nothing is running', async () => {
    const { supervisor } = harness();
    await expect(supervisor.request('ping')).rejects.toThrow('not running');
  });
});

describe('shutdown', () => {
  it('kills the worker and reports STOPPED', () => {
    const { supervisor, latest } = harness();
    supervisor.start();
    latest().spawned();

    supervisor.stop();

    expect(latest().killed).toBe(true);
    expect(supervisor.currentHealth()).toBe('STOPPED');
  });

  // Shutdown must not race a backoff timer into spawning a worker on the way
  // out, or the app quits leaving an orphan behind.
  it('cancels a pending restart', () => {
    const { supervisor, workers, latest } = harness();
    supervisor.start();
    latest().spawned();
    latest().exited();

    supervisor.stop();
    vi.advanceTimersByTime(60_000);

    expect(workers).toHaveLength(1);
    expect(supervisor.currentHealth()).toBe('STOPPED');
  });

  it('refuses to start again after stopping', () => {
    const { supervisor, workers } = harness();
    supervisor.stop();
    supervisor.start();
    expect(workers).toHaveLength(0);
  });

  it('fails pending requests instead of leaving them hanging', async () => {
    const { supervisor, latest } = harness();
    supervisor.start();
    latest().spawned();

    const pending = supervisor.request('ping');
    supervisor.stop();

    await expect(pending).rejects.toThrow('shutting down');
  });
});

describe('health subscriptions', () => {
  it('unsubscribes', () => {
    const { supervisor, latest } = harness();
    const seen: string[] = [];
    const unsubscribe = supervisor.onHealthChange((health) => seen.push(health));

    supervisor.start();
    unsubscribe();
    latest().spawned();

    expect(seen).toEqual(['STARTING']);
  });

  it('survives a listener that throws', () => {
    const { supervisor, errors, latest } = harness();
    supervisor.onHealthChange(() => {
      throw new Error('listener exploded');
    });

    expect(() => supervisor.start()).not.toThrow();
    latest().spawned();

    expect(supervisor.currentHealth()).toBe('HEALTHY');
    expect(errors.some((message) => message.includes('health listener threw'))).toBe(true);
  });

  it('does not repeat an unchanged health value', () => {
    const { supervisor, latest } = harness();
    const seen: string[] = [];
    supervisor.start();
    latest().spawned();
    supervisor.onHealthChange((health) => seen.push(health));

    supervisor.start();
    expect(seen).toEqual([]);
  });
});
