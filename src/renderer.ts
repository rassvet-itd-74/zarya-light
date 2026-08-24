/**
 * Renderer — untrusted UI.
 *
 * A status readout, not the Phase 9 interface. It exists so that the whole path
 * is observable end to end when the app runs: renderer → preload → validated
 * IPC handler → application service → worker → back.
 *
 * It reaches the application only through `window.zarya`. There is no Node here,
 * no filesystem path it could act on, and no signer.
 */

import type { AppStatus, WorkerHealth } from './adapters/electron/ipcContract';

const el = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found;
};

const setRows = (target: HTMLElement, rows: readonly [string, string][]): void => {
  target.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );
};

const renderHealth = (health: WorkerHealth): void => {
  const target = el('worker-health');
  target.textContent = health;
  target.dataset.health = health;
};

const render = (status: AppStatus): void => {
  setRows(el('status'), [
    ['Version', status.appVersion],
    ['Network', `${status.networkName} (${status.chainId})`],
    ['Contract', status.contractAddress],
    ['RPC host', status.rpcHost],
    ['Executor interval', `${status.executorPollIntervalSeconds}s`],
    ['Member wallet', status.memberSignerConfigured ? 'configured' : 'not configured'],
    ['Executor wallet', status.executorSignerConfigured ? 'configured' : 'not configured'],
    [
      'Worker protocol',
      status.worker.protocolVersion === null ? 'no answer' : `v${status.worker.protocolVersion}`,
    ],
    [
      'Worker uptime',
      status.worker.uptimeSeconds === null ? 'no answer' : `${status.worker.uptimeSeconds}s`,
    ],
  ]);
  renderHealth(status.worker.health);
};

const refresh = async (): Promise<void> => {
  try {
    render(await window.zarya.getAppStatus());
  } catch (error) {
    el('status').textContent =
      error instanceof Error ? error.message : 'could not read application status';
  }
};

window.zarya.onWorkerHealth(renderHealth);
el('refresh').addEventListener('click', () => void refresh());
void refresh();
