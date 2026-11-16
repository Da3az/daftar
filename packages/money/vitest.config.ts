import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure functions, no database, no network. These run in milliseconds and are
    // the only tests in the repo that need no container.
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
