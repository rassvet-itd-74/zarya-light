import { BrowserWindow, app, dialog, ipcMain, nativeImage, safeStorage } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
// Inlined as a data URL at build time, so the icon resolves identically in dev
// and in a packaged asar without a runtime path lookup. nativeImage accepts
// PNG/JPEG data URLs but not ICO, so the window icon uses logo.png; favicon.ico
// is the packaging and HTML icon.
import logoDataUrl from './assets/logo.png?inline';

import { type AppConfig, ConfigError, loadConfig } from './adapters/config/appConfig';
import { pushWorkerHealth, registerIpcHandlers } from './adapters/electron/ipcHandlers';
import { buildWindowPlan } from './adapters/electron/windowOptions';
import { createUtilityProcessSpawner } from './adapters/electron/workerHost';
import { WorkerSupervisor } from './adapters/electron/workerSupervisor';
import type {
  ImportFormPayload,
  SubmitOperationPayload,
  IssueTemplatePayload,
  MatrixReportPayload,
  WorkerHealth,
} from './adapters/electron/workerProtocol';
import {
  SafeStorageKeyStore,
  keyFileAt,
} from './adapters/platform/safeStorageKeyStore';
import type { WorkerProbe } from './app/getAppStatus';

/**
 * Composition root. This file wires; it decides nothing.
 *
 * Anything with a rule in it lives in `src/domain/`, `src/app/`, or an adapter,
 * where it can be tested without launching Electron.
 */

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const isDev = Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);

if (isDev) {
  try {
    // Development convenience only: a packaged app must never pick up a stray
    // .env from whatever directory it happens to be launched in. Nothing is
    // baked into the bundle — this reads the file at runtime, and .env is
    // gitignored.
    process.loadEnvFile('.env');
  } catch {
    // No .env is the normal case; configuration falls back to its defaults.
  }
}

/**
 * Configuration is loaded before anything else and failure is fatal. A client
 * pointed at the wrong network or a malformed address must never reach a write
 * path, so this fails closed rather than degrading.
 */
let config: AppConfig;
try {
  config = loadConfig({ appVersion: app.getVersion() });
} catch (error) {
  const detail =
    error instanceof ConfigError || error instanceof Error
      ? error.message
      : 'unknown configuration error';
  // Shown rather than logged: without a window the user would otherwise see the
  // app fail to start with no explanation.
  dialog.showErrorBox('Zarya cannot start', detail);
  app.quit();
  throw error;
}

/**
 * The member wallet: created once, encrypted by the OS, never configured by
 * hand. It lives here because `safeStorage` is main-only.
 *
 * **There is no backup.** The encryption is bound to this OS account, so a lost
 * profile is an address that can never act again — an open product decision,
 * recorded in `INVARIANTS.md`.
 */
const keyStore = new SafeStorageKeyStore(safeStorage, keyFileAt(app.getPath('userData')));

/**
 * Hands the worker the key, on every start.
 *
 * On the supervisor's restart hook rather than once at boot: a worker that
 * crashed and came back has no key, and one that signed with a stale value would
 * be worse than one that refuses. The address is logged; the key never is.
 */
const provisionSigner = (): void => {
  const key = keyStore.unlock();
  if (key === undefined) {
    console.warn('[main] no member wallet available — sending is unavailable');
    return;
  }
  void supervisor
    .request({ kind: 'useMemberKey', payload: { privateKey: key } })
    .then((reply) => {
      console.log(
        reply.kind === 'signerReady'
          ? `[main] worker will sign as ${reply.address}`
          : '[main] the worker rejected the member wallet',
      );
    })
    .catch(() => {
      // Never echoes the request: it contains the key.
      console.error('[main] could not provision the worker with the member wallet');
    });
};

const supervisor = new WorkerSupervisor({
  spawn: createUtilityProcessSpawner({
    appVersion: config.publicConfig.appVersion,
    // Electron creates this directory; the worker only has to open a file in it.
    userDataPath: app.getPath('userData'),
  }),
  onRestart: (reason) => {
    // Phase 7 wires reconcile() here. Every trigger — startup, restart,
    // reconnect, and the UI's Run now — must converge on that one path.
    console.log(`[main] worker started (${reason})`);
    provisionSigner();
  },
  onError: (error) => {
    console.error('[main] worker supervisor:', error.message);
  },
});

/**
 * Windows whose renderer is actually listening.
 *
 * `isDestroyed()` is not enough, and a real run is what showed it: the worker
 * reports `HEALTHY` within milliseconds of `app.ready`, well before the first
 * frame has committed, and `webContents.send` then fails with `Render frame was
 * disposed before WebFrameMain could be accessed`. Electron **logs that itself**,
 * so a `try`/`catch` around the send silences nothing — the only fix is not to
 * send.
 *
 * Membership is the renderer's own signal rather than a timer: `did-finish-load`
 * means the preload ran and the listener is registered. Missing a push costs
 * nothing anyway — the renderer reads the same health from `getAppStatus` on
 * every refresh — so the conservative direction is to send too rarely.
 */
const readyWindows = new Set<Electron.WebContents>();

const trackReadiness = (contents: Electron.WebContents): void => {
  contents.on('did-finish-load', () => readyWindows.add(contents));
  // A reload disposes the old frame and builds a new one, so readiness has to be
  // withdrawn and re-earned rather than latched once.
  contents.on('did-start-loading', () => readyWindows.delete(contents));
  contents.on('destroyed', () => readyWindows.delete(contents));
};

supervisor.onHealthChange((health: WorkerHealth) => {
  pushWorkerHealth([...readyWindows], health);
});

const workerProbe: WorkerProbe = {
  health: () => supervisor.currentHealth(),
  probe: async () => {
    if (!supervisor.isRunning()) return null;
    try {
      const reply = await supervisor.request({ kind: 'ping' });
      return reply.kind === 'pong'
        ? { protocolVersion: reply.protocolVersion, uptimeSeconds: reply.uptimeSeconds }
        : null;
    } catch {
      // A worker that does not answer is a status, not a crash. `health()`
      // already reports DEGRADED.
      return null;
    }
  },
  network: async () => {
    if (!supervisor.isRunning()) return null;
    try {
      const reply = await supervisor.request({ kind: 'checkNetwork' });
      return reply.kind === 'network' ? reply.status : null;
    } catch {
      // Same rule: unasked is not the same as failed. The renderer shows
      // NOT_CHECKED rather than inventing a verdict.
      return null;
    }
  },
};

/**
 * Issuance, from main's side: pick a destination, then delegate.
 *
 * The dialog is here because it belongs to the window. Everything after it is the
 * worker's — the record, the document, the file — so this object is the whole of
 * main's involvement in producing a governance form.
 *
 * `defaultPath` starts in Documents rather than at the last-used directory:
 * there is no last-used directory to remember yet, and guessing the app's own
 * installation folder would be worse than a familiar default.
 */
const chooseDestination = async (suggestedName: string): Promise<string | null> => {
  const parent = BrowserWindow.getAllWindows()[0];
  const result = await dialog.showSaveDialog(parent, {
    title: 'Zarya',
    defaultPath: path.join(app.getPath('documents'), suggestedName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    // The dialog does the overwrite confirmation, which is why FileSink does
    // not: asking twice would overrule an answer we just received.
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  return result.canceled || result.filePath.length === 0 ? null : result.filePath;
};

const issuanceGateway = {
  chooseDestination,

  issue: async (payload: IssueTemplatePayload) =>
    await supervisor.request({ kind: 'issueTemplate', payload }),
};

/**
 * The matrix report, from main's side. Same split as issuance: the dialog is
 * here, everything after it is the worker's.
 *
 * The timeout is the one difference worth reading. A report projects the
 * contract's whole event history and then reads every cell it found. Measured
 * against Sepolia on 2026-09-05 the projection is about a second — eighteen
 * windows — but that figure is a floor: the matrix was empty, so no cell reads
 * happened at all, and both halves grow, one with the chain's height and one
 * with the number of populated coordinates. The supervisor's ten-second liveness
 * timeout would abort a working report and mark the worker degraded for
 * finishing its job.
 *
 * Five minutes is therefore not an expectation. It is an upper bound past which
 * something is genuinely wrong, chosen wide because the alternative — tuning it
 * to a matrix nobody has populated yet — would be guessing with a worse
 * failure mode.
 */
const MATRIX_REPORT_TIMEOUT_MS = 5 * 60_000;

const matrixReportGateway = {
  chooseDestination,

  generate: async (payload: MatrixReportPayload) =>
    await supervisor.request(
      { kind: 'generateMatrixReport', payload },
      { timeoutMs: MATRIX_REPORT_TIMEOUT_MS },
    ),
};

/**
 * Import, from main's side. The only dialog here that **opens** a file.
 *
 * `openFile` alone — no `multiSelections`, no `openDirectory` — because the
 * worker reads whatever path comes back, and the batch engine that would justify
 * several at once is Phase 8. Widening this is a decision about what the
 * application does, not a dialog option.
 *
 * A generous timeout for the same reason the report has one: an import parses a
 * document, reads the local record, and for a numerical value proposal makes a
 * chain call. That is more than the ten-second liveness probe was sized for,
 * though far less than a full matrix projection.
 */
const IMPORT_TIMEOUT_MS = 60_000;

const importFormGateway = {
  chooseSource: async (): Promise<string | null> => {
    const parent = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(parent, {
      title: 'Zarya',
      defaultPath: app.getPath('documents'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    const [chosen] = result.filePaths;
    return result.canceled || chosen === undefined ? null : chosen;
  },

  importForm: async (payload: ImportFormPayload) =>
    await supervisor.request({ kind: 'importForm', payload }, { timeoutMs: IMPORT_TIMEOUT_MS }),
};

/**
 * Sending, from main's side. The dialog here is not a save dialog — it is the
 * asking.
 *
 * Hard rule 1 says a transaction is never broadcast unless explicitly asked, and
 * this is where the asking happens: a modal that names the operation, says
 * plainly what is about to occur, and defaults to the cancel button.
 *
 * **What it protects against, precisely.** A mis-click. It is not a defence
 * against a compromised renderer, which could invoke the channel with any
 * reference and would simply see its own choice named back — that boundary is
 * held by the payload carrying nothing but a reference, and by the worker
 * deriving everything else from the stored document.
 *
 * The timeout is the largest in the application. Submission signs, reads a nonce,
 * and broadcasts — potentially three times for a threshold configuration — and
 * each of those waits on a provider. A timeout that fired mid-send would leave a
 * transaction in flight with nothing waiting for its hash, which is precisely the
 * ambiguous state recovery-by-nonce exists to resolve and which is far better
 * avoided than resolved.
 */
const SUBMIT_TIMEOUT_MS = 180_000;

const submitOperationGateway = {
  confirm: async (operationRef: string): Promise<boolean> => {
    const parent = BrowserWindow.getAllWindows()[0];
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'Zarya',
      message: 'Send this operation to Sepolia?',
      detail:
        `Operation ${operationRef}\n\n` +
        'This signs and broadcasts a transaction from the configured member wallet. ' +
        'A transaction cannot be recalled once it has been sent, and it costs Sepolia ETH ' +
        'whether or not the contract accepts it.',
      buttons: ['Cancel', 'Send'],
      // Cancel is both the default and the escape action, so neither Enter nor
      // Escape sends anything.
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  },

  submitOperation: async (payload: SubmitOperationPayload) =>
    await supervisor.request({ kind: 'submitOperation', payload }, { timeoutMs: SUBMIT_TIMEOUT_MS }),
};

const createWindow = (): void => {
  const plan = buildWindowPlan({
    isDev,
    preloadPath: path.join(__dirname, 'preload.js'),
  });

  const mainWindow = new BrowserWindow({
    ...plan.options,
    icon: nativeImage.createFromDataURL(logoDataUrl),
  });

  // The app never opens a second window or an external one.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  trackReadiness(mainWindow.webContents);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  if (plan.openDevTools) {
    mainWindow.webContents.openDevTools();
  }

  // A preload failure would otherwise be silent in production: the window
  // renders and every call through `window.zarya` is simply missing.
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[main] preload failed at ${preloadPath}:`, error.message);
  });
};

app.on('ready', () => {
  // Before the worker starts, so the first provisioning has something to send.
  // `safeStorage` is only reliable after `ready`, which is why this is not at
  // module load.
  void keyStore.ensure().then((state) => {
    console.log(
      state.address === undefined
        ? `[main] member wallet unavailable: ${state.message ?? state.status}`
        : `[main] member wallet ${state.status}: ${state.address}`,
    );
  });

  // utilityProcess.fork is only legal after `ready`.
  supervisor.start('initial');

  registerIpcHandlers({
    ipcMain,
    deps: { publicConfig: config.publicConfig, worker: workerProbe },
    issuance: issuanceGateway,
    matrixReport: matrixReportGateway,
    importForm: importFormGateway,
    submitOperation: submitOperationGateway,
    onError: (channel, error) => {
      // The unsanitized error stops here. The renderer received a generic one.
      console.error(`[main] ${channel}:`, error);
    },
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  // On macOS the worker deliberately keeps running with no window open: chain
  // work must not depend on renderer lifetime.
});

app.on('activate', () => {
  // Recreating a window must not fork a second worker. `start()` is idempotent,
  // and this path does not call it at all.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  // Cancels any pending restart before killing, so shutdown cannot race a
  // backoff timer into spawning a worker on the way out.
  supervisor.stop();
});
