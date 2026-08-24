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
import type { WorkerHealth } from './adapters/electron/workerProtocol';
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
  spawn: createUtilityProcessSpawner(),
  onRestart: (reason) => {
    // Phase 7 wires reconcile() here. Every trigger — startup, restart,
    // reconnect, and the UI's Run now — must converge on that one path.
    console.log(`[main] worker started (${reason})`);
  },
  onError: (error) => {
    console.error('[main] worker supervisor:', error.message);
  },
});

supervisor.onHealthChange((health: WorkerHealth) => {
  pushWorkerHealth(
    BrowserWindow.getAllWindows().map((window) => window.webContents),
    health,
  );
});

const workerProbe: WorkerProbe = {
  health: () => supervisor.currentHealth(),
  probe: async () => {
    if (!supervisor.isRunning()) return null;
    try {
      const reply = await supervisor.request('ping');
      return reply.kind === 'pong'
        ? { protocolVersion: reply.protocolVersion, uptimeSeconds: reply.uptimeSeconds }
        : null;
    } catch {
      // A worker that does not answer is a status, not a crash. `health()`
      // already reports DEGRADED.
      return null;
    }
  },
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
