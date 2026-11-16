import { writeFile } from 'node:fs/promises';
import { pino } from 'pino';
import { buildApp } from '../app.ts';
import { createPool } from '../db/pool.ts';
import { env } from '../env.ts';

/**
 * Write the generated OpenAPI document to `apps/api/openapi.json`.
 *
 * Builds the real app so the document is produced by the same Zod schemas the
 * server validates against — a hand-maintained spec file drifts, and a drifted
 * spec is worse than none because it is believed.
 *
 * No `listen()`: `app.ready()` runs the plugin tree, which is all
 * `@fastify/swagger` needs. No port is bound and no request is served, so this
 * is safe to run in CI.
 *
 * The pool is created but never queried. It exists because `buildApp` decorates
 * the instance with it; `pool.end()` in the `finally` keeps the process from
 * hanging on an open socket.
 */
const pool = createPool({
  connectionString: env.DATABASE_URL,
  max: 1,
  applicationName: 'daftar-openapi-dump',
});

const outputPath = new URL('../../openapi.json', import.meta.url);

try {
  // Silent: the only output this script should produce is the file it wrote,
  // so a caller can pipe it or diff it in CI without filtering log lines out.
  const app = await buildApp({ pool, loggerOverride: pino({ level: 'silent' }) });
  await app.ready();

  const document = app.swagger();
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  await app.close();
  process.stdout.write(`wrote ${outputPath.pathname}\n`);
} catch (err) {
  process.stderr.write(`openapi dump failed: ${String(err)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
