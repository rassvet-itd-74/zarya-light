import { defineConfig } from 'vitest/config';

// Tests colocate with their subject as `*.test.ts`. Everything testable today
// is main-process or pure domain code, so `node` is the only environment needed.
// A renderer project with a DOM environment gets added when a renderer test
// exists, not before.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Loads .env so the opt-in fork tests can see ZARYA_FORK_RPC_URL. They skip
    // themselves when it is absent, so an offline run stays green.
    setupFiles: ['./vitest.setup.ts'],
    /**
     * Up from the 5s default, because several tests are genuinely this slow.
     *
     * A form test issues all eleven templates, and each one embeds PT Sans
     * **whole** — ~327 KB per document, which is a deliberate decision recorded
     * in `issueTemplate.ts` rather than something to optimise away. Eleven of
     * those is seconds of real work, and it was already close to the default
     * before the issuance round trip added more of it; files run in parallel, so
     * the margin depended on how busy the machine was, which is the worst way
     * for a suite to fail.
     *
     * The fork suites still pass their own longer timeouts explicitly: starting
     * anvil and forking Sepolia is a different order of slow, and saying so at
     * the test is clearer than one number covering both.
     */
    testTimeout: 20_000,
  },
});
