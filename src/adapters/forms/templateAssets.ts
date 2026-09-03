import { readFileSync } from 'node:fs';
import fontBoldUrl from '../../assets/pt-sans/PTSans-Bold.ttf?inline';
import fontRegularUrl from '../../assets/pt-sans/PTSans-Regular.ttf?inline';
import logoUrl from '../../assets/logo.png?inline';
import type { TemplateAssets } from './issueTemplate';

/**
 * The font and logo bytes, for the worker that draws documents.
 *
 * `issueTemplate` takes its assets as bytes precisely so it never has to know
 * where they came from, and this is the module that knows. It exists because
 * Vite's `?inline` resolves to a **data URL in a build and to a path string
 * under vitest**, so an issuer that imported its own font would be untestable
 * against the real file — the note on `issueTemplate` says as much.
 *
 * Both forms are handled here rather than one being declared unsupported. The
 * worker is not unit-tested through this path today, but a module that worked in
 * production and threw in a test would be one nobody could add a test to later.
 *
 * ## The cost, stated
 *
 * Three assets inlined as base64 is roughly 600 KB in the worker bundle — the
 * two PT Sans faces are ~320 KB each before encoding. That is the price of the
 * `?inline` pattern `main.ts` already uses for the window icon, and the
 * alternative is copying files into the build output and resolving them at
 * runtime relative to `__dirname`, which differs between dev, a packaged asar,
 * and a test. One decoding cost at worker startup beats three path resolutions
 * that can each be wrong in a different environment.
 */

let cached: TemplateAssets | undefined;

/** Loaded once. The bytes are immutable and every issuance wants the same three. */
export function loadTemplateAssets(): TemplateAssets {
  cached ??= {
    fontRegular: assetBytes(fontRegularUrl),
    fontBold: assetBytes(fontBoldUrl),
    logoPng: assetBytes(logoUrl),
  };
  return cached;
}

/**
 * A `?inline` import to bytes, whichever form the bundler gave us.
 *
 * A data URL is decoded; anything else is treated as a path and read. The
 * discriminator is the `data:` scheme rather than the environment, so this does
 * not need to know whether it is in a test.
 */
export function assetBytes(imported: string): Uint8Array {
  const comma = imported.startsWith('data:') ? imported.indexOf(',') : -1;
  if (comma !== -1) {
    return new Uint8Array(Buffer.from(imported.slice(comma + 1), 'base64'));
  }
  // Synchronous, and only ever at startup: an issuance that had to await its own
  // font would put a filesystem read inside the request path.
  return new Uint8Array(readFileSync(imported));
}
