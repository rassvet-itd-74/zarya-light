/**
 * The background worker process.
 *
 * Everything long-running or failure-prone belongs here: chain reads, form
 * generation and parsing (Phase 4), the transaction queue (Phase 6), and
 * reconciliation (Phase 7). It holds no correctness-critical state in memory —
 * it may be killed and restarted at any moment, and the supervisor's restart
 * hook re-runs reconciliation rather than resuming a timer.
 *
 * This is where chain access lives, and where it stays: the renderer cannot
 * reach a provider, and neither can the main process.
 */

import type { ParentPort } from 'electron';
import { ChainClock } from './adapters/chain/chainClock';
import { ZaryaNetworkGuard } from './adapters/chain/networkGuard';
import {
  type NetworkStatusView,
  toNetworkStatusView,
} from './adapters/chain/networkStatusView';
import { createZaryaPublicClient } from './adapters/chain/publicClient';
import { type AppConfig, loadConfig } from './adapters/config/appConfig';
import type { Clock } from './domain/ports/Clock';
import type { NetworkGuard } from './domain/ports/NetworkGuard';
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

/**
 * Chain wiring, built once on first use rather than at module load: a
 * configuration failure should be reportable as a reply, not a silent exit
 * before the supervisor has anyone to tell.
 *
 * The worker loads its own configuration from the inherited environment, so the
 * RPC URL never travels in a message.
 */
interface ChainContext {
  config: AppConfig;
  guard: NetworkGuard;
  clock: Clock;
}

let chainContext: ChainContext | undefined;
let chainContextError: string | undefined;

const getChainContext = (): ChainContext => {
  if (chainContext !== undefined) return chainContext;
  if (chainContextError !== undefined) throw new Error(chainContextError);

  try {
    const config = loadConfig({ appVersion: process.env.ZARYA_APP_VERSION ?? '0.0.0' });
    const client = createZaryaPublicClient({ rpcUrl: config.secretConfig.rpcUrl });
    chainContext = {
      config,
      guard: new ZaryaNetworkGuard(client, config.publicConfig.contractAddress),
      clock: new ChainClock(client),
    };
    return chainContext;
  } catch (error) {
    // The message is authored by loadConfig and never echoes the RPC URL.
    chainContextError = error instanceof Error ? error.message : 'configuration failed';
    throw new Error(chainContextError);
  }
};

const checkNetwork = async (): Promise<NetworkStatusView> =>
  toNetworkStatusView(await getChainContext().guard.verify());

const handle = async (request: WorkerRequest): Promise<WorkerReply> => {
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

    case 'checkNetwork':
      return { kind: 'network', requestId, status: await checkNetwork() };
  }

  // Exhaustiveness: adding a request kind without handling it fails to compile
  // rather than silently replying "unsupported" in production.
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

  void handle(received)
    .then((reply) => parentPort.postMessage(reply))
    .catch((error: unknown) => {
      console.error('[worker] request failed', error);
      parentPort.postMessage({
        kind: 'failure',
        requestId: received.requestId,
        // Only our own messages cross; anything else would risk carrying a
        // provider URL or a stack trace.
        message:
          error instanceof Error ? error.message : `failed to handle ${received.kind}`,
      } satisfies WorkerReply);
    });
});
