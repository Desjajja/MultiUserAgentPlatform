import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
});
