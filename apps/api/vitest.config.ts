import { defineConfig } from 'vitest/config';
import { DEFAULT_TEST_POSTGRES_URL } from './test/support/postgres-url.ts';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    /**
     * `test/broker/` needs Redpanda (and is run by `npm run test:broker`, which
     * sets BROKER_TESTS=1). Excluded otherwise, so `npm test` keeps needing
     * PostgreSQL and nothing else. When included it fails loudly if the broker
     * is not there — it never skips.
     */
    exclude: process.env['BROKER_TESTS'] === '1' ? [] : ['test/broker/**'],
    environment: 'node',

    /**
     * Set before any test module is imported, so `src/env.ts` validates
     * successfully instead of calling `process.exit(78)` and taking the worker
     * down with it.
     *
     * `TEST_DATABASE_URL` from the real environment wins (CI points it at the
     * service container); otherwise the compose service on loopback.
     */
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_POSTGRES_URL,
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
      ALLOW_FLAG_HEADERS: 'true',

      /**
       * The chaos endpoints ship with per-IP limits of 10 and 6 per minute. The
       * suite fires far more than that in a few seconds from one address, and
       * without raising them here the chaos tests assert against the rate
       * limiter rather than against the ledger — which is exactly the mistake
       * the Phase 1 load harness made once already.
       *
       * Raised only for the suite. The defaults in `src/env.ts` are what ships.
       */
      CHAOS_SESSION_RATE_MAX: '10000',
      CHAOS_BURST_RATE_MAX: '10000',
    },

    /**
     * Creates the migrated template database once per run, then drops it and any
     * leftover clones. Test files clone from it.
     */
    globalSetup: ['./test/support/global-setup.ts'],

    /**
     * One process per test file, each with its own cloned database.
     *
     * `forks`, not `threads`: the `pg` driver and the type-parser registry are
     * module-level mutable state, and worker threads in the same process would
     * share neither cleanly nor predictably. Process isolation also means a test
     * that deliberately exhausts a pool cannot affect a sibling file.
     */
    pool: 'forks',

    /**
     * Per-file isolation, which is the default and is relied on here: each file
     * gets its own process and its own cloned database. (`poolOptions` was
     * removed in Vitest 4 — those settings are top-level now, and the ones that
     * used to be set here are already the defaults.)
     */
    isolate: true,

    /**
     * Generous: several tests intentionally wait on a lock or a configured
     * timeout. A tight default here produces flaky failures that look like
     * concurrency bugs and are not.
     */
    testTimeout: 30_000,
    hookTimeout: 60_000,

    /**
     * No retries. A concurrency test that passes on the second attempt is not a
     * passing test — it is a flaky one, and hiding that defeats the purpose of
     * the whole suite. Races are made deterministic with explicit barriers
     * instead.
     */
    retry: 0,

    sequence: {
      // Deterministic file order makes a failure reproducible from the log.
      shuffle: false,
    },
  },

  /**
   * Workspace packages resolve to source in tests. The built `dist/` is what the
   * server imports at runtime (Node refuses to strip types under node_modules),
   * but making the test suite depend on a prior build would mean a stale `dist`
   * could make a failing change look green.
   */
  resolve: {
    alias: {
      '@daftar/money': new URL('../../packages/money/src/index.ts', import.meta.url).pathname,
    },
  },
});
