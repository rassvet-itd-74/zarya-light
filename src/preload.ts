// The renderer's only channel to the application.
//
// Runs with contextIsolation and sandbox on, so this file may use nothing but
// the narrow Electron surface below. Whatever `contextBridge` exposes here is
// the complete set of capabilities the UI has — see `preloadApi.ts` and
// INVARIANTS.md, "Electron trust boundary". Raw `ipcRenderer` never crosses.
import { contextBridge, ipcRenderer } from 'electron';
import { ZARYA_API_GLOBAL } from './adapters/electron/ipcContract';
import { createZaryaApi } from './adapters/electron/preloadApi';

contextBridge.exposeInMainWorld(ZARYA_API_GLOBAL, createZaryaApi(ipcRenderer));
