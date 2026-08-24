/**
 * The renderer's Content-Security-Policy.
 *
 * This matters more here than in a typical desktop app. The renderer will
 * eventually display text extracted from returned PDF forms, which are untrusted
 * by rule (INVARIANTS.md, "Form trust boundary"). CSP is the layer that stops a
 * field value from becoming executable content if any rendering path ever slips.
 *
 * Delivered as a `<meta http-equiv>` tag injected into `index.html` by the
 * renderer's Vite config, not as a response header. The packaged app loads its
 * renderer over `file://`, where a `session.webRequest.onHeadersReceived` header
 * is not dependably applied; a meta tag is part of the document either way. Pure
 * so the policy itself can be asserted in a test.
 */

export interface CspInput {
  isDev: boolean;
  /** Vite dev server origin, e.g. `http://localhost:5173`. Dev only. */
  devServerOrigin?: string;
}

/**
 * `script-src` is `'self'` in **both** modes. Vite's dev server serves its
 * client and the entry as module `src=` scripts rather than inline ones, so no
 * `'unsafe-inline'` or `'unsafe-eval'` allowance is needed — verified by running
 * the dev server under this policy. Development therefore gets exactly the
 * production script rules, and the only difference is the HMR websocket.
 *
 * `style-src` allows inline styles: the shell's styles live in `index.html`, and
 * Vite injects dev styles as `<style>` elements at runtime.
 */
export function contentSecurityPolicy({ isDev, devServerOrigin }: CspInput): string {
  const hmrWebSocket =
    isDev && devServerOrigin !== undefined ? [devServerOrigin.replace(/^http/, 'ws')] : [];

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    // The renderer makes no network requests of its own — chain and file work
    // happens in main and the worker. In dev this is the HMR socket only.
    'connect-src': ["'self'", ...hmrWebSocket],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };

  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

/**
 * The `<meta>` tag to inject into `index.html`. Attribute values are quoted and
 * the policy contains no `"` of its own, so no escaping is needed — asserted in
 * the test rather than assumed.
 */
export function contentSecurityPolicyMetaTag(input: CspInput): string {
  return `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(input)}" />`;
}
