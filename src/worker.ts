/**
 * The background worker process.
 *
 * Everything long-running or failure-prone belongs here: chain reads (Phase 2),
 * form generation and parsing (Phase 4), the transaction queue (Phase 6), and
 * reconciliation (Phase 7). It holds no correctness-critical state in memory —
 * it may be killed and restarted at any moment, and the supervisor's restart
 * hook re-runs reconciliation rather than resuming a timer.
 *
 * Today it answers `ping`. The dispatcher shape is what matters: one validated
 * request in, one reply out, unknown requests refused rather than ignored.
 */

import type { ParentPort } from 'electron';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerReply,
  type WorkerRequest,
  isWorkerRequest,
} from './adapters/electron/workerProtocol';

// Present only inside a utilityProcess. The typings declare it unconditionally,
// so the annotation is what makes the guard below meaningful.
const parentPort: ParentPort | undefined = process.parentPort;

if (parentPort === undefined) {
  // Nobody to talk to, and staying alive would leave an unreachable process.
  console.error('[worker] no parent port — this entry point must be forked by the main process');
  process.exit(1);
}

const handle = (request: WorkerRequest): WorkerReply => {
  const { requestId } = request;

  switch (request.kind) {
    case 'ping':
      return {
        kind: 'pong',
        requestId,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        // process.uptime(), not a wall clock: this is a liveness figure, and no
        // deadline decision may ever be made from workstation time.
        uptimeSeconds: Math.floor(process.uptime()),
      };
  }

  // Exhaustiveness: adding a request kind without handling it fails to compile
  // rather than silently replying "unsupported" in production. Narrowed on
  // `.kind` rather than on `request`, so it holds whether the request type is a
  // union or — as today — a single shape.
  const unhandled: never = request.kind;
  return {
    kind: 'failure',
    requestId,
    message: `unsupported request ${String(unhandled)}`,
  };
};

parentPort.on('message', (messageEvent) => {
  const received: unknown = messageEvent.data;

  if (!isWorkerRequest(received)) {
    // No requestId to answer against, so there is nothing to reply to. Logged
    // rather than thrown: an unparseable message means a version skew between a
    // stale build and a fresh one, not a reason to take the worker down.
    console.error('[worker] discarded an unrecognized message from the main process');
    return;
  }

  try {
    parentPort.postMessage(handle(received));
  } catch (error) {
    console.error('[worker] request failed', error);
    parentPort.postMessage({
      kind: 'failure',
      requestId: received.requestId,
      message: `failed to handle ${received.kind}`,
    } satisfies WorkerReply);
  }
});
