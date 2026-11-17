import { z } from 'zod';

/**
 * Environment is validated **once, at module load**, and the process exits if it
 * is wrong.
 *
 * The alternative — reading `process.env.FOO` where it is needed — fails
 * mid-request, in production, on the one code path nobody exercised. A
 * mistyped `DB_POOL_MAX` should stop a deploy, not surface as a 500 an hour
 * later.
 */

/**
 * `"true"` / `"1"` / `"yes"` / `"on"` are all truthy; everything else, including
 * the empty string, is false. Written out rather than using `Boolean(value)`,
 * because `Boolean("false")` is `true` and that is a bug waiting to be shipped.
 */
const boolish = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', '']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes' || v === 'on');

/** The three concurrency strategies of Phase 3. All correct; they trade off. */
export const LEDGER_CONCURRENCY_MODES = ['pessimistic', 'serializable', 'advisory'] as const;
export type LedgerConcurrencyMode = (typeof LEDGER_CONCURRENCY_MODES)[number];

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /**
   * A full libpq connection URI. Required with no default on purpose: a default
   * of `localhost` is how a test run ends up writing to a developer's real
   * database.
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * Connection-pool ceiling. The arithmetic that has to hold:
   *
   *   (API instances x DB_POOL_MAX) + (workers x worker pool) + superuser_reserved
   *     <= postgres max_connections
   *
   * Phase 6 writes this out against the real numbers. Until then the default is
   * deliberately small, so exhausting it during a Phase 1 load run is visible
   * rather than masked by a generous pool.
   */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),

  /** Milliseconds a caller waits for a free connection before failing. */
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

  /** Milliseconds an idle connection is kept before being closed. */
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),

  /**
   * Server-side statement timeout, applied per connection. A ledger write that
   * takes longer than this is holding locks that other writers are queued
   * behind, so failing it is the lesser harm.
   */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Pretty-print logs. Off by default: the canonical line is meant to be parsed. */
  LOG_PRETTY: boolish.default(false),

  /**
   * Process-wide *defaults* for the per-request flags. Every one of these can be
   * overridden per request by a header — see `src/flags.ts`. Nothing in the
   * request path reads these directly, which is what makes the chaos panel able
   * to run two profiles side by side.
   */
  LEDGER_CONCURRENCY_MODE: z.enum(LEDGER_CONCURRENCY_MODES).default('serializable'),

  /**
   * How many times the ledger write may be retried after a serialization
   * failure or a deadlock.
   *
   * Configurable because it is the knob that defines `serializable`'s
   * trade-off, and Phase 3 measures the trade rather than asserting it: a low
   * bound sheds load fast and returns errors, a high bound converts those
   * errors into latency. The benchmark runs both and publishes both.
   *
   * Bounded, always. An unbounded retry loop under sustained contention is an
   * outage amplifier — every retry adds work to the system that caused the
   * conflict.
   */
  LEDGER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),

  /**
   * Phase 1 naive paths. Both default off. They are permanent deliverables, not
   * leftovers: a described failure is marketing, a runnable one is evidence.
   */
  DAFTAR_NAIVE_OVERDRAFT: boolish.default(false),
  DAFTAR_NAIVE_LOST_UPDATE: boolish.default(false),

  /**
   * Whether request headers are allowed to override the flags above. On in
   * development and test; must be switched on explicitly anywhere else, because
   * an unauthenticated header that selects a deliberately-broken ledger path is
   * exactly the kind of thing that should not be reachable by default.
   */
  ALLOW_FLAG_HEADERS: boolish.optional(),

  /**
   * Global per-IP request ceiling.
   *
   * Configurable because a load run comes from **one** IP and is therefore
   * indistinguishable from the abuse this limit exists to stop. Left at the
   * default, the Phase 1 harness's 500 virtual users trip it and the run
   * measures the rate limiter instead of the ledger — which it did, once.
   *
   * Every evidence file records the value that was in force. Raising it for a
   * measurement is legitimate; raising it silently is not, which is why it is an
   * environment variable with a conservative default rather than a hardcoded
   * number someone has to go read the source to discover.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(1_000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),

  /** Comma-separated allowlist for CORS. Empty means same-origin only. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
});

type RawEnv = z.infer<typeof schema>;

/**
 * `ALLOW_FLAG_HEADERS` is optional in the schema but always resolved by `load`,
 * so the exported type makes it required. Consumers never have to handle an
 * `undefined` that cannot actually occur.
 */
export type Env = Omit<RawEnv, 'ALLOW_FLAG_HEADERS'> & { ALLOW_FLAG_HEADERS: boolean };

function load(source: NodeJS.ProcessEnv): Env {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    // Written to stderr directly, not through pino: the logger is configured
    // *from* this object, so it does not exist yet. This is the one sanctioned
    // write to stderr outside the canonical log line.
    process.stderr.write(
      `\nInvalid environment — refusing to start.\n\n${z.prettifyError(parsed.error)}\n\n`,
    );
    process.exit(78); // EX_CONFIG, sysexits.h
  }

  const env = parsed.data;

  // Defaulting one field from another cannot be expressed inside the schema
  // without making the field's type optional at every use site, so it happens
  // here, once, where both values are known.
  return {
    ...env,
    ALLOW_FLAG_HEADERS: env.ALLOW_FLAG_HEADERS ?? env.NODE_ENV !== 'production',
  };
}

export const env: Env = load(process.env);

/**
 * Exposed for tests, which need to assert the validation itself rejects things
 * without taking the process down. Returns the raw schema result — the
 * `ALLOW_FLAG_HEADERS` fallback is `load`'s job.
 */
export const parseEnv = (source: NodeJS.ProcessEnv) => schema.safeParse(source);
