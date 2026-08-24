import { defineConfig } from 'vitest/config';

// Tests colocate with their subject as `*.test.ts`. Everything testable today
// is main-process or pure domain code, so `node` is the only environment needed.
// A renderer project with a DOM environment gets added when a renderer test
// exists, not before.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
