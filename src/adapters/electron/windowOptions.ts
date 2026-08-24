import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * Builds the main window's options.
 *
 * A pure function on purpose. The three flags below are the renderer's entire
 * containment, and a test that asserts them is worth more than a comment asking
 * a future edit not to weaken them. They are set explicitly rather than left to
 * Electron's defaults for the same reason: a default can change between
 * versions, and an explicit `false` is visible in a diff.
 */

export interface WindowOptionsInput {
  /** True only when the Vite dev server is serving the renderer. */
  isDev: boolean;
  /** Absolute path to the built preload script. */
  preloadPath: string;
}

export interface WindowPlan {
  options: BrowserWindowConstructorOptions;
  /** DevTools are opened only in development. */
  openDevTools: boolean;
}

export const WINDOW_TITLE = 'Zarya';

/**
 * The window icon is attached by the caller: it needs `nativeImage`, which is a
 * runtime call, and this function stays pure so its security flags are testable.
 */

export function buildWindowPlan({ isDev, preloadPath }: WindowOptionsInput): WindowPlan {
  return {
    options: {
      width: 1024,
      height: 720,
      minWidth: 800,
      minHeight: 600,
      title: WINDOW_TITLE,
      // Nothing is rendered until the first paint, which avoids a white flash
      // on a slow first load.
      show: false,
      webPreferences: {
        preload: preloadPath,
        // The renderer is untrusted UI. All three are load-bearing:
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Nothing in this app renders remote content; disallow it outright.
        webviewTag: false,
        // Defence in depth against a compromised renderer probing the app's
        // own origin. The renderer talks to the app only through preload.
        webSecurity: true,
        devTools: isDev,
      },
    },
    openDevTools: isDev,
  };
}
