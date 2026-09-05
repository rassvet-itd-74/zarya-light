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
import path from 'node:path';
import { ChainClock } from './adapters/chain/chainClock';
import { ZaryaNetworkGuard } from './adapters/chain/networkGuard';
import {
  type NetworkStatusView,
  toNetworkStatusView,
} from './adapters/chain/networkStatusView';
import { ZaryaOrganResolver } from './adapters/chain/organResolver';
import {
  type ZaryaPublicClient,
  createZaryaPublicClient,
} from './adapters/chain/publicClient';
import { type AppConfig, loadConfig } from './adapters/config/appConfig';
import { FormTemplateWriter } from './adapters/forms/formTemplateWriter';
import { loadTemplateAssets } from './adapters/forms/templateAssets';
import { CryptoIdGenerator } from './adapters/platform/cryptoIdGenerator';
import { NodeFileSink } from './adapters/platform/nodeFileSink';
import { type DatabaseHandle, openDatabase } from './adapters/store/database';
import { SqliteOperationStore } from './adapters/store/sqliteOperationStore';
import { partyOrganTriple } from './domain/organs/partyOrgan';
import { regionBySubjectCode } from './domain/organs/regions';
import { OPERATION_TYPES, type OperationType } from './domain/intents/intent';
import type { Clock } from './domain/ports/Clock';
import type { NetworkGuard } from './domain/ports/NetworkGuard';
import type { OrganResolver } from './domain/ports/OrganResolver';
import {
  type IssueTemplateRequest,
  issueOperationTemplate,
} from './app/issueOperationTemplate';
import {
  WORKER_PROTOCOL_VERSION,
  type ImportFormPayload,
  type IssueTemplatePayload,
  type MatrixReportPayload,
  type WorkerReply,
  type WorkerRequest,
  isWorkerRequest,
} from './adapters/electron/workerProtocol';
import { ZaryaMatrixEvents } from './adapters/chain/matrixEvents';
import { ZaryaMatrixReader } from './adapters/chain/matrixReader';
import { ZaryaMatrixSnapshot } from './adapters/chain/matrixSnapshot';
import { MatrixReportRenderer } from './adapters/forms/renderMatrixReport';
import { PdfReturnedFormReader } from './adapters/forms/returnedFormReader';
import { NodeFileSource } from './adapters/platform/nodeFileSource';
import { describeIntent } from './domain/intents/describeIntent';
import { generateMatrixReport } from './app/generateMatrixReport';
import { importReturnedForm } from './app/importReturnedForm';

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
  /**
   * Kept beside the ports rather than discarded after building them.
   *
   * The report's two chain dependencies are constructed **per request**, not
   * once: `ZaryaMatrixSnapshot` is pinned to a block, so an instance is only
   * valid for the report that pinned it, and reusing one would silently date a
   * second report with the first one's block.
   */
  client: ZaryaPublicClient;
  guard: NetworkGuard;
  clock: Clock;
  organs: OrganResolver;
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
      client,
      guard: new ZaryaNetworkGuard(client, config.publicConfig.contractAddress),
      clock: new ChainClock(client),
      organs: new ZaryaOrganResolver(client, config.publicConfig.contractAddress),
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

/**
 * The local database, opened once, in **this** process and nowhere else.
 *
 * `ARCHITECTURE.md` puts the queue, reconciliation and form work in the worker,
 * so a second handle in main would mean two processes writing one file for no
 * gain. Status reaches the UI over this protocol instead.
 *
 * The directory comes from `ZARYA_USER_DATA`, because `app.getPath('userData')`
 * is a main-process call and a `utilityProcess` cannot make it. Passed in the
 * environment for the same reason the RPC URL is: a value that arrives once at
 * fork time cannot be swapped by a later message.
 *
 * Opened lazily and remembered as a *failure* as well as a success — a database
 * that cannot be opened is not going to open on the next request either, and
 * retrying per request would turn one bad path into a loop of identical errors.
 */
let store: DatabaseHandle | undefined;
let storeError: string | undefined;

const DATABASE_FILE = 'zarya.db';

const getStore = (): DatabaseHandle => {
  if (store !== undefined) return store;
  if (storeError !== undefined) throw new Error(storeError);

  try {
    const directory = process.env.ZARYA_USER_DATA;
    if (directory === undefined || directory.length === 0) {
      throw new Error('ZARYA_USER_DATA was not set, so there is nowhere to keep the local record');
    }
    store = openDatabase(path.join(directory, DATABASE_FILE));
    console.log(`[worker] store open at schema version ${store.version}`);
    return store;
  } catch (error) {
    storeError = error instanceof Error ? error.message : 'could not open the local database';
    // Logged here as well as replied, because the first request that needs it may
    // be minutes after startup and the cause is a startup condition.
    console.error(`[worker] store unavailable: ${storeError}`);
    throw new Error(storeError);
  }
};

/**
 * The schema version for the status readout, or `null`.
 *
 * Never throws: `ping` is the liveness probe, and a probe that failed because the
 * database is missing would report the worker as unreachable when it is running
 * and merely unable to record anything.
 */
const schemaVersion = (): number | null => {
  try {
    return getStore().version;
  } catch {
    return null;
  }
};

/**
 * A message payload into the use case's request, or a refusal.
 *
 * This is the **second** validation of this payload — main validated it on
 * arrival from the renderer — and the two check different things. Main checks
 * shape: could this have come from the preload surface we shipped. This checks
 * *meaning* against the tables that own it: is that a real operation type, is
 * that a real subject code. `INVARIANTS.md` asks for both, and neither is
 * redundant, because a wrong subject code is a perfectly well-shaped string.
 *
 * The region conversion is the one worth watching. A subject code becomes an
 * **ordinal** only through `regionBySubjectCode`, so there is no numeric route
 * from this message to a call argument — the two differ for 50 of 98 regions and
 * a wrong one addresses a different real region rather than failing.
 */
type IssuePlan =
  | { readonly kind: 'PLAN'; readonly request: IssueTemplateRequest }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: string };

const planIssuance = (payload: IssueTemplatePayload): IssuePlan => {
  const operationType = OPERATION_TYPES.find((known) => known === payload.operationType);
  if (operationType === undefined) {
    return {
      kind: 'REFUSED',
      code: 'UNKNOWN_OPERATION_TYPE',
      message: `${payload.operationType} is not an operation this application can issue`,
    };
  }

  let organ: IssueTemplateRequest['organ'];
  if (payload.organType !== undefined) {
    try {
      // `partyOrganTriple` normalizes away what the organ's scope ignores, so a
      // region supplied for a global organ is discarded here rather than being
      // carried into a hash that would not match.
      organ = partyOrganTriple({
        organType: payload.organType as never,
        ...(payload.regionSubjectCode === undefined
          ? {}
          : { region: regionBySubjectCode(payload.regionSubjectCode).ordinal }),
        ...(payload.organNumber === undefined ? {} : { number: payload.organNumber }),
      });
    } catch (error) {
      return {
        kind: 'REFUSED',
        code: 'INVALID_ORGAN',
        message: error instanceof Error ? error.message : 'that organ is not usable',
      };
    }
  }

  return {
    kind: 'PLAN',
    request: {
      operationType: operationType as OperationType,
      ...(organ === undefined ? {} : { organ }),
      ...(payload.votingId === undefined ? {} : { votingId: payload.votingId }),
      targetPath: payload.targetPath,
    },
  };
};

const issue = async (payload: IssueTemplatePayload, requestId: string): Promise<WorkerReply> => {
  const plan = planIssuance(payload);
  if (plan.kind === 'REFUSED') {
    return { kind: 'refused', requestId, code: plan.code, message: plan.message };
  }

  const chain = getChainContext();
  const outcome = await issueOperationTemplate(
    {
      organs: chain.organs,
      store: new SqliteOperationStore(getStore().db),
      templates: new FormTemplateWriter(loadTemplateAssets()),
      files: new NodeFileSink(),
      ids: new CryptoIdGenerator(),
      deployment: {
        chainId: chain.config.publicConfig.chainId,
        contractAddress: chain.config.publicConfig.contractAddress,
      },
    },
    plan.request,
  );

  if (outcome.kind === 'REFUSED') {
    return { kind: 'refused', requestId, code: outcome.code, message: outcome.message };
  }
  return {
    kind: 'issued',
    requestId,
    operationRef: outcome.operationRef,
    path: outcome.path,
    organIdentifier: outcome.organIdentifier ?? null,
    fieldCount: outcome.fieldCount,
  };
};

/**
 * The matrix reference report, from the worker's side.
 *
 * Almost nothing to validate, and that is a property of the document rather than
 * an omission: a report is not addressed. There is no operation type, no organ
 * and no coordinate range a caller could get wrong — the payload is a
 * destination, and everything that decides what the page says is read here from
 * the chain and the configuration.
 *
 * The two chain dependencies are built per request. The snapshot is pinned to a
 * block, so an instance outlives its own validity the moment the report using it
 * is finished, and `ZaryaMatrixEvents` is built alongside it for symmetry rather
 * than cached — it holds nothing but a client and an address.
 *
 * `loadTemplateAssets()` is the same call issuance makes, and the fonts are the
 * reason: the report prints Cyrillic organ labels and axis text, so PT Sans has
 * to be embedded here exactly as it is in a form.
 */
const report = async (
  payload: MatrixReportPayload,
  requestId: string,
): Promise<WorkerReply> => {
  const chain = getChainContext();
  const address = chain.config.publicConfig.contractAddress;

  const outcome = await generateMatrixReport(
    {
      snapshots: {
        pin: async () => await ZaryaMatrixSnapshot.atConfirmedHead(chain.client, address),
      },
      events: new ZaryaMatrixEvents(chain.client, address),
      organs: chain.organs,
      reports: new MatrixReportRenderer(loadTemplateAssets()),
      files: new NodeFileSink(),
      // Widened here, at the call site, exactly as `PublicConfig` says to.
      deploymentBlock: BigInt(chain.config.publicConfig.deploymentBlock),
    },
    { targetPath: payload.targetPath },
  );

  if (outcome.kind === 'REFUSED') {
    return { kind: 'refused', requestId, code: outcome.code, message: outcome.message };
  }
  return {
    kind: 'reported',
    requestId,
    path: outcome.path,
    pageCount: outcome.pageCount,
    // Decimal string: a bigint does not survive the structured clone.
    blockNumber: outcome.blockNumber.toString(),
    readAt: outcome.readAt,
    rows: outcome.rows,
    degradedRows: outcome.degradedRows,
    empty: outcome.empty,
  };
};

/**
 * A returned form, from the worker's side.
 *
 * Like the report, almost nothing to validate: the payload is a path, and every
 * value that decides anything is recovered here — from the file for the
 * member-filled half, from the local record for the app-authored half, and from
 * the chain for the one key the schema resolves.
 *
 * `ZaryaMatrixReader` and not the report's pinned snapshot: an import asks what
 * is true **now**, because the scale it recovers is about to produce a number a
 * transaction will carry.
 */
const importForm = async (
  payload: ImportFormPayload,
  requestId: string,
): Promise<WorkerReply> => {
  const chain = getChainContext();
  const address = chain.config.publicConfig.contractAddress;

  const outcome = await importReturnedForm(
    {
      files: new NodeFileSource(),
      forms: new PdfReturnedFormReader(),
      store: new SqliteOperationStore(getStore().db),
      matrix: new ZaryaMatrixReader(chain.client, address),
      deployment: {
        chainId: chain.config.publicConfig.chainId,
        contractAddress: address,
      },
    },
    { sourcePath: payload.sourcePath },
  );

  if (outcome.kind === 'REFUSED') {
    // The problems are folded into the message rather than dropped: a refusal
    // naming no field tells a member their form is wrong and nothing else.
    const detail = outcome.problems
      .map((problem) => (problem.field === undefined ? problem.message : `${problem.field}: ${problem.message}`))
      .join(' ');
    return {
      kind: 'refused',
      requestId,
      code: outcome.code,
      message: detail.length > 0 ? `${outcome.message} ${detail}` : outcome.message,
    };
  }

  return {
    kind: 'imported',
    requestId,
    operationRef: outcome.operationRef,
    operationType: outcome.operationType,
    // Flattened here, once, because a bigint does not cross reliably.
    fields: describeIntent(outcome.intent),
    warnings: outcome.warnings.map((warning) => ({
      code: warning.code,
      ...(warning.field === undefined ? {} : { field: warning.field }),
      message: warning.message,
    })),
  };
};

const handle = async (request: WorkerRequest): Promise<WorkerReply> => {
  // Destructured before the switch narrows `request` away entirely, so the
  // exhaustiveness check below still has a name to report.
  const { requestId, kind } = request;

  switch (request.kind) {
    case 'ping':
      return {
        kind: 'pong',
        requestId,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        // process.uptime(), not a wall clock: this is a liveness figure, and no
        // deadline decision may ever be made from workstation time.
        uptimeSeconds: Math.floor(process.uptime()),
        schemaVersion: schemaVersion(),
      };

    case 'checkNetwork':
      return { kind: 'network', requestId, status: await checkNetwork() };

    case 'issueTemplate':
      return await issue(request.payload, requestId);

    case 'generateMatrixReport':
      return await report(request.payload, requestId);

    case 'importForm':
      return await importForm(request.payload, requestId);
  }

  // Exhaustiveness: adding a request kind without handling it fails to compile
  // rather than silently replying "unsupported" in production.
  const unhandled: never = request;
  void unhandled;
  return { kind: 'failure', requestId, message: `unsupported request ${kind}` };
};

/**
 * Opened at startup rather than at first use, and the throw is deliberately
 * dropped.
 *
 * Lazily was the first version, and a real run showed why it is worse: the
 * database is not touched until something needs it, so a wrong path or a
 * corrupted file stays invisible until a member has already chosen where to save
 * a form. Opening here means the log says what happened at start, and `getStore`
 * has already memoized the failure — so the first request still answers with the
 * reason instead of retrying a path that will not work.
 *
 * Not fatal. A worker that cannot record can still answer `ping` and
 * `checkNetwork`, and reporting a schema version of `null` in the status readout
 * is more use to whoever has to fix it than a process that exits.
 */
try {
  getStore();
} catch {
  // Already logged and remembered by `getStore`.
}

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
