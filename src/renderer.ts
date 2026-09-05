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

// ---------------------------------------------------------- matrix report

/**
 * The coordinate reference.
 *
 * One button and no inputs, because a report is not addressed: there is one
 * matrix, and the document is all of it as of one block.
 *
 * The wait is the part this panel has to handle honestly. Generating a report
 * projects the contract's whole event history and then reads every cell it
 * found — tens of seconds against a public endpoint — with no progress channel
 * behind it yet. So the button disables for the duration and says what is
 * happening, rather than looking like a press that did nothing.
 */
const showReportResult = (outcome: string, message: string): void => {
  const target = el('report-result');
  target.hidden = false;
  target.dataset.outcome = outcome;
  target.textContent = message;
};

/** Chain time, from the pinned block. Never `Date.now()`. */
const blockTime = (readAt: number): string => new Date(readAt * 1000).toISOString();

const generateReport = async (): Promise<void> => {
  const button = el('generate-report') as HTMLButtonElement;
  button.disabled = true;
  // One message covering both waits, because the renderer cannot tell them
  // apart: the dialog and the whole projection are a single await. Saying so is
  // better than a "waiting for a location" that stays on screen for a minute
  // after the location was chosen.
  showReportResult(
    'WORKING',
    'Choose a location, then the matrix is read from the beginning of the ' +
      'contract — this can take a while.',
  );

  try {
    const result = await window.zarya.generateMatrixReport();

    switch (result.kind) {
      case 'REPORTED': {
        // `degradedRows` is reported rather than folded into the success line: a
        // report can be written *and* incomplete, and the page marks those rows
        // — so saying "done" alone would be the one summary the document itself
        // contradicts.
        const scope = result.empty
          ? 'no coordinates yet — the axis inventory only'
          : `${result.rows} coordinate${result.rows === 1 ? '' : 's'}` +
            (result.degradedRows > 0
              ? `, ${result.degradedRows} with fields that did not read`
              : '');
        showReportResult(
          'REPORTED',
          `Saved to ${result.path} — ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}, ` +
            `${scope}. Read at block ${result.blockNumber} (${blockTime(result.readAt)}).`,
        );
        break;
      }
      case 'CANCELLED':
        showReportResult('CANCELLED', 'Nothing was written.');
        break;
      case 'REFUSED':
        showReportResult('REFUSED', `${result.code}: ${result.message}`);
        break;
      case 'FAILED':
        showReportResult('FAILED', result.message);
        break;
    }
  } catch (error) {
    showReportResult(
      'FAILED',
      error instanceof Error ? error.message : 'the application could not read the matrix',
    );
  } finally {
    button.disabled = false;
  }
};

// --------------------------------------------------------------- import

/**
 * The return half.
 *
 * The panel's job is to show **what the application understood**, not to
 * decide anything. A returned form is untrusted (hard rule 4), the values it
 * authored come from the local record, and this is where a member sees the
 * result of that before anything is submitted — which is the whole reason the
 * intent is rendered field by field rather than summarised in a sentence.
 *
 * Warnings are drawn even on success, and separately from the outcome line.
 * A context field edited in the file and an appearance that disagrees with its
 * value are both tamper evidence; neither changes the intent, which is exactly
 * why neither may be folded away into a green result.
 */
const showImportResult = (outcome: string, message: string): void => {
  const target = el('import-result');
  target.hidden = false;
  target.dataset.outcome = outcome;
  target.textContent = message;
};

const renderImportWarnings = (
  warnings: readonly { code: string; field?: string; message: string }[],
): void => {
  const target = el('import-warnings');
  target.hidden = warnings.length === 0;
  target.replaceChildren(
    ...warnings.map((warning) => {
      const item = document.createElement('li');
      item.textContent =
        warning.field === undefined
          ? warning.message
          : `${warning.field} — ${warning.message}`;
      return item;
    }),
  );
};

const clearImport = (): void => {
  el('import-fields').hidden = true;
  el('import-warnings').hidden = true;
};

const importForm = async (): Promise<void> => {
  const button = el('import-form') as HTMLButtonElement;
  button.disabled = true;
  clearImport();
  showImportResult('WORKING', 'Choose a filled form…');

  try {
    const result = await window.zarya.importForm();

    switch (result.kind) {
      case 'IMPORTED': {
        showImportResult(
          'IMPORTED',
          `${result.operationType}, recorded as ${result.operationRef}. ` +
            'Nothing has been submitted — there is no submission path yet.',
        );
        const fields = el('import-fields');
        fields.hidden = false;
        setRows(
          fields,
          result.fields.map((field) => [field.label, field.value] as [string, string]),
        );
        renderImportWarnings(result.warnings);
        break;
      }
      case 'CANCELLED':
        showImportResult('CANCELLED', 'Nothing was imported.');
        break;
      case 'REFUSED':
        // The reason is the point here: every refusal names something a member
        // can act on — a wrong deployment, a form already imported, a field that
        // does not validate.
        showImportResult('REFUSED', `${result.code}: ${result.message}`);
        break;
      case 'FAILED':
        showImportResult('FAILED', result.message);
        break;
    }
  } catch (error) {
    showImportResult(
      'FAILED',
      error instanceof Error ? error.message : 'the application could not import that form',
    );
  } finally {
    button.disabled = false;
  }
};

select('operation-type').addEventListener('change', syncFields);
select('organ-type').addEventListener('change', syncFields);
el('issue').addEventListener('click', () => void issue());
el('generate-report').addEventListener('click', () => void generateReport());
el('import-form').addEventListener('click', () => void importForm());
syncFields();

window.zarya.onWorkerHealth(renderHealth);
el('refresh').addEventListener('click', () => void refresh());
void refresh();
