import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * SQL held in `.sql` files rather than template literals.
 *
 * The statement query is the one Phase 6 benchmarked and `EXPLAIN`ed, and the
 * evidence file quotes it verbatim. Keeping it in a file means the thing that
 * was measured and the thing that runs are the same text — a query inlined in
 * TypeScript drifts from the one in the evidence the first time someone
 * reformats it.
 *
 * Read once at module load and cached. Reading per request would put a
 * filesystem call on a read path that otherwise makes exactly one.
 */
const cache = new Map<string, string>();

async function load(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const path = fileURLToPath(new URL(`./${name}.sql`, import.meta.url));
  const sql = await readFile(path, 'utf8');
  cache.set(name, sql);
  return sql;
}

/** The account statement with a running balance. See `statement.sql`. */
export const statementSql = (): Promise<string> => load('statement');
