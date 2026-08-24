import { utilityProcess } from 'electron';
import path from 'node:path';
import type { SpawnWorker, WorkerHandle } from './workerSupervisor';

/**
 * Spawns the background worker as an Electron `utilityProcess`.
 *
 * A separate OS process rather than a worker thread: the worker will host native
 * modules, the transaction queue, and long chain reads, and it must be able to
 * crash and be restarted without taking the window with it
 * (ARCHITECTURE.md, "Trust boundaries").
 *
 * Messaging goes over `process.parentPort` rather than a `MessageChannelMain`
 * pair. A channel would let a port be handed to the renderer; keeping the
 * parent port means the only path from the renderer to the worker runs through
 * main, where payloads are validated.
 *
 * This is the one module that imports `electron` for the worker's sake, so
 * `WorkerSupervisor` stays testable with a fake.
 */

export const WORKER_SERVICE_NAME = 'zarya-worker';

/** Sits next to `main.js` in the Vite build output. */
const workerEntryPath = (): string => path.join(__dirname, 'worker.js');

export function createUtilityProcessSpawner(appVersion: string): SpawnWorker {
  return (): WorkerHandle =>
    utilityProcess.fork(workerEntryPath(), [], {
      serviceName: WORKER_SERVICE_NAME,
      // The worker inherits the environment and loads its own configuration, so
      // the RPC URL never travels in a message. Only the app version, which the
      // worker cannot ask Electron for, is passed explicitly.
      env: { ...process.env, ZARYA_APP_VERSION: appVersion },
      // Worker stdout/stderr joins the main process log stream. Nothing secret
      // is written there: SecretConfig redacts itself.
      stdio: 'inherit',
    });
}
