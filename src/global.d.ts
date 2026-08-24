import type { ZaryaDesktopApi } from './adapters/electron/ipcContract';

declare global {
  interface Window {
    /**
     * Everything the renderer can reach, installed by the preload script. If it
     * is not on this object, the UI cannot do it.
     */
    readonly zarya: ZaryaDesktopApi;
  }
}
