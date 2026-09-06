/**
 * The background worker: chain reads, forms, the transaction queue,
 * reconciliation. It may be killed at any moment and holds no
 * correctness-critical state in memory.
 *
 * Chain access lives here and nowhere else.
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
  type MemberKeyPayload,
  type SubmitOperationPayload,
  type WorkerReply,
  type WorkerRequest,
  isWorkerRequest,
} from './adapters/electron/workerProtocol';
import { privateKeyToAccount } from 'viem/accounts';
import { ZaryaReceipts } from './adapters/chain/zaryaReceipts';
import { PrivateKeySigner } from './adapters/chain/zaryaSigner';
import { ZaryaWriteCallEncoder } from './adapters/chain/writeCallEncoder';
import { SqliteTransactionStore } from './adapters/store/sqliteTransactionStore';
import type { OperationRef } from './domain/primitives';
import { submitImportedOperation } from './app/submitImportedOperation';
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
 * The database, opened once in **this** process. A second handle in main would
 * mean two processes writing one file.
 *
 * The directory comes from `ZARYA_USER_DATA` — `app.getPath` is a main-process
 * call. Failures are memoized: a path that will not open will not open on the
 * next request either.
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
 * The **second** validation: main checked shape, this checks meaning against the
 * tables that own it. A wrong subject code is a perfectly well-shaped string.
 *
 * A subject code becomes an ordinal only through `regionBySubjectCode`. The two
 * differ for 50 of 98 regions, and a wrong one addresses a different real region
 * rather than failing.
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
 * Nothing to validate: a report is not addressed, so the payload is a
 * destination and everything else is read here.
 *
 * The snapshot is built per request because it is pinned to a block — reusing
 * one would date a second report with the first one's block.
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
 * `ZaryaMatrixReader`, not the report's pinned snapshot: an import asks what is
 * true **now**, because the scale it recovers becomes a number in a transaction.
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

/**
 * The member wallet's key, held for this worker's lifetime and nowhere else.
 *
 * Main decrypts it — `safeStorage` exists only there — and sends it once per
 * worker start. It lives in this module-local, is handed to a signer built per
 * request, and is never written, logged, replied with, or stored.
 *
 * A restarted worker has no key until main provisions it again, which is
 * correct: the supervisor re-runs that hook, and a worker that came back without
 * one must refuse to sign rather than sign with something stale.
 */
let memberKey: `0x${string}` | undefined;

/**
 * Accepts the key and answers with the **address**.
 *
 * The address is derived here rather than trusted from the message, so the reply
 * is a statement about the key the worker actually holds. Deriving it is also the
 * validation: a malformed key fails here, at startup, instead of at the moment a
 * member presses send.
 */
const acceptMemberKey = (payload: MemberKeyPayload, requestId: string): WorkerReply => {
  try {
    const account = privateKeyToAccount(payload.privateKey as `0x${string}`);
    memberKey = payload.privateKey as `0x${string}`;
    return { kind: 'signerReady', requestId, address: account.address };
  } catch {
    // The message is never echoed — it is the key. Nothing about its content
    // reaches this string.
    memberKey = undefined;
    return {
      kind: 'refused',
      requestId,
      code: 'UNUSABLE_KEY',
      message: 'The member wallet this application holds is not a usable signing key.',
    };
  }
};

/**
 * **The only path in this application that broadcasts.**
 *
 * The payload is one `operationRef`; everything a transaction says is recovered
 * here. Nothing a renderer could set reaches the chain.
 *
 * The signer is built per request, so the object holding key material is garbage
 * as soon as the reply is posted. No wallet is a refusal, not a failure.
 */
const submit = async (
  payload: SubmitOperationPayload,
  requestId: string,
): Promise<WorkerReply> => {
  const chain = getChainContext();
  if (memberKey === undefined) {
    return {
      kind: 'refused',
      requestId,
      code: 'NO_SIGNER',
      message:
        'This worker holds no member wallet, so nothing can be signed. If the application just ' +
        'restarted, wait for it to finish starting; if secure storage is unavailable on this ' +
        'system, no wallet could be created.',
    };
  }

  const address = chain.config.publicConfig.contractAddress;
  const outcome = await submitImportedOperation(
    {
      signer: new PrivateKeySigner(memberKey, chain.config.secretConfig.rpcUrl),
      receipts: new ZaryaReceipts(chain.client),
      encoder: new ZaryaWriteCallEncoder(chain.organs),
      transactions: new SqliteTransactionStore(getStore().db),
      store: new SqliteOperationStore(getStore().db),
      forms: new PdfReturnedFormReader(),
      matrix: new ZaryaMatrixReader(chain.client, address),
      ids: new CryptoIdGenerator(),
      deployment: { chainId: chain.config.publicConfig.chainId, contractAddress: address },
    },
    { operationRef: payload.operationRef as OperationRef },
  );

  if (outcome.kind === 'NOT_SENT') {
    const detail = outcome.detail.join(' ');
    return {
      kind: 'refused',
      requestId,
      code: outcome.code,
      message: detail.length > 0 ? `${outcome.message} ${detail}` : outcome.message,
    };
  }
  if (outcome.kind === 'REFUSED') {
    return { kind: 'refused', requestId, code: outcome.code, message: outcome.message };
  }

  // `SUBMITTED` and `PARTIALLY_SUBMITTED` share a reply, because both mean bytes
  // left this machine and the attempts have to be reported either way. Folding
  // the partial case into a refusal would tell a member nothing happened when
  // something already has, and nothing can undo it.
  return {
    kind: 'submitted',
    requestId,
    operationRef: payload.operationRef,
    partial: outcome.kind === 'PARTIALLY_SUBMITTED',
    attempts: outcome.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      hash: attempt.hash,
      nonce: attempt.nonce,
    })),
    ...(outcome.kind === 'PARTIALLY_SUBMITTED' ? { message: outcome.message } : {}),
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

    case 'submitOperation':
      return await submit(request.payload, requestId);

    case 'useMemberKey':
      return acceptMemberKey(request.payload, requestId);
  }

  // Exhaustiveness: adding a request kind without handling it fails to compile
  // rather than silently replying "unsupported" in production.
  const unhandled: never = request;
  void unhandled;
  return { kind: 'failure', requestId, message: `unsupported request ${kind}` };
};

/**
 * Opened at startup, and the throw dropped on purpose. Lazily, a bad path stayed
 * invisible until a member had already chosen where to save a form.
 *
 * Not fatal: a worker that cannot record still answers `ping` and
 * `checkNetwork`, and reports a `null` schema version.
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
