import { BrowserWindow, app, dialog, ipcMain, nativeImage } from 'electron';
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
  IssueTemplatePayload,
  WorkerHealth,
} from './adapters/electron/workerProtocol';
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
const issuanceGateway = {
  chooseDestination: async (suggestedName: string): Promise<string | null> => {
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
  },

  issue: async (payload: IssueTemplatePayload) =>
    await supervisor.request({ kind: 'issueTemplate', payload }),
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
  // utilityProcess.fork is only legal after `ready`.
  supervisor.start('initial');

  registerIpcHandlers({
    ipcMain,
    deps: { publicConfig: config.publicConfig, worker: workerProbe },
    issuance: issuanceGateway,
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
