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

import { OPERATION_TITLES, labelText } from './adapters/forms/formLabels';
import { CONTEXT_FIELDS, contextFieldsFor } from './adapters/forms/formSchema';
import { OPERATION_TYPES, type OperationType } from './domain/intents/intent';
import {
  PARTY_ORGAN_TYPES,
  type PartyOrganType,
  scopeOf,
} from './domain/organs/partyOrgan';
import { REGIONS } from './domain/organs/regions';
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

const renderNetwork = (network: AppStatus['network']): void => {
  const target = el('network');
  target.textContent = network.detail;
  target.dataset.status = network.status;
  // Unusable-but-transient reads differently from unusable-and-settled: one is
  // "retrying", the other is "fix your configuration".
  target.dataset.severity = network.usable ? 'ok' : network.transient ? 'pending' : 'blocked';
};

const render = (status: AppStatus): void => {
  renderNetwork(status.network);
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

// ---------------------------------------------------------------- issuance

/**
 * The form-issuing panel.
 *
 * Everything here is **UX, not authorization** (hard rule 6). Hiding the organ
 * fields for a theme voting spares a member three meaningless questions; it is
 * not what stops an organ reaching a call that has no argument for it. Main
 * validates the payload's shape on arrival and the worker checks its meaning
 * against the tables that own it, and either can refuse what this panel allowed.
 *
 * The operation names are the party's own — the same Russian a member reads at
 * the top of the form they are about to be handed, rather than a second
 * vocabulary invented for the UI.
 */
const select = (id: string): HTMLSelectElement => el(id) as HTMLSelectElement;
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement;

const fill = (
  target: HTMLSelectElement,
  options: readonly { value: string; text: string }[],
): void => {
  target.replaceChildren(
    ...options.map(({ value, text }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      return option;
    }),
  );
};

fill(
  select('operation-type'),
  OPERATION_TYPES.map((type) => ({ value: type, text: labelText(OPERATION_TITLES[type]) })),
);
fill(
  select('organ-type'),
  PARTY_ORGAN_TYPES.map((type) => ({ value: type, text: type })),
);
fill(
  select('region'),
  // The subject code is what a member reads off a document, so it is what the
  // option carries. The ordinal a call needs is derived in the worker, through
  // the region table, and never travels in this message.
  REGIONS.map((region) => ({
    value: region.subjectCode as string,
    text: `${region.subjectCode} — ${region.name}`,
  })),
);

/** Which questions this operation actually has, derived from the field plan. */
const syncFields = (): void => {
  const operationType = select('operation-type').value as OperationType;
  const context = contextFieldsFor(operationType);
  const needsOrgan = context.includes(CONTEXT_FIELDS.organ);
  const scope = scopeOf(select('organ-type').value as PartyOrganType);

  el('field-organ-type').hidden = !needsOrgan;
  el('field-region').hidden = !needsOrgan || scope === 'GLOBAL';
  el('field-organ-number').hidden = !needsOrgan || scope !== 'LOCAL';
  el('field-voting-id').hidden = !context.includes(CONTEXT_FIELDS.votingId);
};

const showIssueResult = (outcome: string, message: string): void => {
  const target = el('issue-result');
  target.hidden = false;
  target.dataset.outcome = outcome;
  target.textContent = message;
};

const issue = async (): Promise<void> => {
  const operationType = select('operation-type').value as OperationType;
  const context = contextFieldsFor(operationType);
  const needsOrgan = context.includes(CONTEXT_FIELDS.organ);
  const organType = select('organ-type').value as PartyOrganType;
  const scope = scopeOf(organType);

  const button = el('issue') as HTMLButtonElement;
  button.disabled = true;
  showIssueResult('CANCELLED', 'Waiting for a location…');

  try {
    const result = await window.zarya.issueTemplate({
      operationType,
      // Sent only where the operation has one. An organ on a theme voting is
      // refused rather than ignored, so offering it would be a dead end.
      ...(needsOrgan
        ? {
            organType,
            ...(scope === 'GLOBAL' ? {} : { regionSubjectCode: select('region').value }),
            ...(scope === 'LOCAL'
              ? { organNumber: Number(input('organ-number').value || '0') }
              : {}),
          }
        : {}),
      ...(context.includes(CONTEXT_FIELDS.votingId)
        ? { votingId: input('voting-id').value }
        : {}),
    });

    switch (result.kind) {
      case 'ISSUED':
        showIssueResult(
          'ISSUED',
          `Saved to ${result.path} — ${result.fieldCount} fields, recorded as ${result.operationRef}` +
            (result.organIdentifier === null ? '' : `, organ ${result.organIdentifier}`),
        );
        break;
      case 'CANCELLED':
        // An answer, not a failure. Nothing was recorded and nothing written.
        showIssueResult('CANCELLED', 'Nothing was issued.');
        break;
      case 'REFUSED':
        showIssueResult('REFUSED', `${result.code}: ${result.message}`);
        break;
      case 'FAILED':
        showIssueResult('FAILED', result.message);
        break;
    }
  } catch (error) {
    showIssueResult(
      'FAILED',
      error instanceof Error ? error.message : 'the application could not issue a form',
    );
  } finally {
    button.disabled = false;
  }
};

select('operation-type').addEventListener('change', syncFields);
select('organ-type').addEventListener('change', syncFields);
el('issue').addEventListener('click', () => void issue());
syncFields();

window.zarya.onWorkerHealth(renderHealth);
el('refresh').addEventListener('click', () => void refresh());
void refresh();
