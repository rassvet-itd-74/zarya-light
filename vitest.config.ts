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
  },
});
