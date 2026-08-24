import { describe, expect, it } from 'vitest';
import { buildWindowPlan } from './windowOptions';

const preloadPath = '/app/.vite/build/preload.js';

describe('buildWindowPlan', () => {
  // These three are the renderer's entire containment. A future edit that
  // weakens one should fail here rather than ship.
  it('contains the renderer in both dev and production', () => {
    for (const isDev of [true, false]) {
      const { options } = buildWindowPlan({ isDev, preloadPath });
      expect(options.webPreferences?.contextIsolation).toBe(true);
      expect(options.webPreferences?.nodeIntegration).toBe(false);
      expect(options.webPreferences?.sandbox).toBe(true);
      expect(options.webPreferences?.webSecurity).toBe(true);
      expect(options.webPreferences?.webviewTag).toBe(false);
    }
  });

  it('wires the preload script', () => {
    const { options } = buildWindowPlan({ isDev: false, preloadPath });
    expect(options.webPreferences?.preload).toBe(preloadPath);
  });

  it('disables DevTools outside development', () => {
    const production = buildWindowPlan({ isDev: false, preloadPath });
    expect(production.openDevTools).toBe(false);
    // Not merely "not opened" — unavailable.
    expect(production.options.webPreferences?.devTools).toBe(false);
  });

  it('enables DevTools in development', () => {
    const development = buildWindowPlan({ isDev: true, preloadPath });
    expect(development.openDevTools).toBe(true);
    expect(development.options.webPreferences?.devTools).toBe(true);
  });
});
