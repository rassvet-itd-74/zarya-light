import {
  NOT_CHECKED,
  type NetworkStatusView,
} from '../adapters/chain/networkStatusView';
import type { PublicConfig } from '../adapters/config/appConfig';
import type { WorkerHealth } from '../adapters/electron/workerProtocol';
import { PERMITTED_NETWORK_NAME } from '../domain/network/networkPolicy';

/**
 * What the app can say about itself without touching the chain.
 *
 * This is the use case's contract with its driving adapters — plain serializable
 * values only, so the same object crosses IPC unchanged. It deliberately carries
 * *whether* signers are configured and never anything about them.
 */
export interface AppStatus {
  readonly appVersion: string;
  readonly chainId: number;
  readonly networkName: string;
  readonly contractAddress: string;
  readonly rpcHost: string;
  readonly executorPollIntervalSeconds: number;
  readonly memberSignerConfigured: boolean;
  readonly executorSignerConfigured: boolean;
  readonly worker: WorkerStatus;
  /**
   * The chain identity verdict. `NOT_CHECKED` while the worker is starting —
   * distinct from a failed check, because "we have not looked" and "it is wrong"
   * must never render the same.
   */
  readonly network: NetworkStatusView;
}

export interface WorkerStatus {
  readonly health: WorkerHealth;
  /** `null` when the worker did not answer — unknown is not zero. */
  readonly protocolVersion: number | null;
  readonly uptimeSeconds: number | null;
}

/**
 * What this use case needs from the worker. An interface here rather than the
 * supervisor itself, so the use case is testable without Electron.
 */
export interface WorkerProbe {
  health(): WorkerHealth;
  /** Resolves `null` if the worker is down or does not answer. */
  probe(): Promise<{ protocolVersion: number; uptimeSeconds: number } | null>;
  /** Resolves `null` if the worker could not be asked at all. */
  network(): Promise<NetworkStatusView | null>;
}

export interface GetAppStatusDeps {
  publicConfig: PublicConfig;
  worker: WorkerProbe;
}

export async function getAppStatus({
  publicConfig,
  worker,
}: GetAppStatusDeps): Promise<AppStatus> {
  // A failed probe is a status to report, not an error to propagate: the UI's
  // job here is to show that the worker is not answering.
  const [probed, network] = await Promise.all([worker.probe(), worker.network()]);

  return {
    appVersion: publicConfig.appVersion,
    chainId: publicConfig.chainId,
    networkName: PERMITTED_NETWORK_NAME,
    contractAddress: publicConfig.contractAddress,
    rpcHost: publicConfig.rpcHost,
    executorPollIntervalSeconds: publicConfig.executorPollIntervalSeconds,
    memberSignerConfigured: publicConfig.memberSignerConfigured,
    executorSignerConfigured: publicConfig.executorSignerConfigured,
    worker: {
      health: worker.health(),
      protocolVersion: probed?.protocolVersion ?? null,
      uptimeSeconds: probed?.uptimeSeconds ?? null,
    },
    // A worker that cannot be asked leaves the verdict unknown, which is not the
    // same as a network that failed its check.
    network: network ?? NOT_CHECKED,
  };
}
