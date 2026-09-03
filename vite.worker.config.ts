import { defineConfig } from 'vite';

/**
 * The worker build. Forge's `main` target: CommonJS output for
 * `utilityProcess.fork`, with Node built-ins and dependencies left external.
 *
 * ## Why `node:sqlite` has to be named explicitly
 *
 * Vite externalizes Node built-ins from `module.builtinModules`, and on the Node
 * that runs this build (22.14) **`node:sqlite` is not in that list** — it is too
 * new. So it falls through to Vite's browser-external stub and the build fails
 * with `"DatabaseSync" is not exported by "__vite-browser-external:node:sqlite"`,
 * which is a *warning* in the log and a **missing `worker.js`** on disk.
 *
 * The symptom that reaches a user is nothing like the cause: `utilityProcess.fork`
 * finds no file, the supervisor restarts, and the log fills with
 * `worker started (restart)` until the attempt limit. Nothing says "your bundler
 * dropped a module".
 *
 * `/^node:/` rather than the one name, because the next built-in to arrive will
 * be missing from that list too, and the worker is the process that legitimately
 * uses Node APIs — the domain is forbidden them by lint and main uses barely any.
 * Prefixed specifiers only: an unprefixed `path` or `fs` is not something this
 * codebase writes, and matching those would also hide a genuine npm dependency
 * that happened to share a built-in's name.
 *
 * This never surfaced before because the worker had **no** `node:*` import at
 * all until it started opening a database. Everything it did — chain reads, the
 * clock, the network guard — went through viem.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      external: [/^node:/],
    },
  },
});
