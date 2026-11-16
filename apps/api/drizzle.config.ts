import { defineConfig } from 'drizzle-kit';

/**
 * Workflow is `generate` -> read the SQL diff -> `migrate`. Never `push`, and
 * never auto-migrate on app boot: drizzle's generated SQL is destructive by
 * default and a boot-time migration turns a rolling deploy into a schema race
 * between instances.
 *
 * Note the limitation this repo depends on: **drizzle-kit cannot emit
 * `CREATE TRIGGER`.** The deferred constraint trigger that enforces
 * `SUM(amount) = 0` per transaction is hand-written through
 * `drizzle-kit generate --custom`. The consequence is that `generate` will never
 * show that trigger in a diff and will never detect its drift, so the trigger
 * has its own test asserting it exists in `pg_trigger` and that PostgreSQL —
 * not the application — rejects an unbalanced transaction.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
  // Fail loudly rather than silently diffing against nothing.
  strict: true,
  verbose: true,
});
