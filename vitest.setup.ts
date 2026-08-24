/**
 * Loads `.env` into `process.env` before tests are collected.
 *
 * Vitest does not do this on its own — Vite only exposes `VITE_`-prefixed values
 * to `import.meta.env` — and the opt-in fork tests decide whether to skip at
 * module load, so it has to happen here rather than inside a test.
 *
 * `process.loadEnvFile` is built into Node, so no dotenv dependency. `.env` is
 * gitignored and holds the fork RPC URL, which may carry an API key: nothing in
 * the suite prints it, and the anvil harness redacts it from failure messages.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // No .env is the normal case in CI. Fork tests skip themselves.
}
