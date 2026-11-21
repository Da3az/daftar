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
   * Phase 4's naive path: lookup-then-insert on the idempotency key instead of
   * letting the UNIQUE index arbitrate. Produces duplicate orders from
   * concurrent retries. A permanent deliverable, like the other two.
   */
  DAFTAR_NAIVE_IDEMPOTENCY: boolish.default(false),

  /**
   * Whether request headers are allowed to override the flags above. On in
   * development and test; must be switched on explicitly anywhere else, because
   * an unauthenticated header that selects a deliberately-broken ledger path is
   * exactly the kind of thing that should not be reachable by default.
   */
  ALLOW_FLAG_HEADERS: boolish.optional(),

  /**
   * Shared secret for inbound webhook signatures.
   *
   * No default outside development: a hardcoded fallback secret is the same
   * thing as no signature check at all, since anyone reading this repo would
   * know it. Required in production, so a deploy that forgets it fails at boot
   * rather than accepting unsigned events.
   */
  WEBHOOK_SIGNING_SECRET: z.string().min(16).optional(),

  /** Replay tolerance in seconds, each way. 300 is Stripe's documented default. */
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),

  /**
   * Signing key for chaos-panel burst tokens.
   *
   * A **separate** secret from `WEBHOOK_SIGNING_SECRET`, not a reuse of it.
   * They protect different things with different blast radii — the webhook
   * secret authenticates money movement from a provider, this one gates a demo
   * button — and sharing a key means rotating either one breaks both, so
   * neither gets rotated.
   *
   * Required in production for the same reason the webhook secret is: with a
   * known fallback, the token gate on an endpoint that opens 200 concurrent
   * transactions is decorative.
   */
  CHAOS_TOKEN_SECRET: z.string().min(16).optional(),

  /**
   * Per-IP ceilings on the chaos endpoints, declared separately from
   * `RATE_LIMIT_MAX` and far tighter.
   *
   * Separate because `RATE_LIMIT_MAX` is raised to six figures for benchmark
   * runs, and a burst endpoint that inherits that inherits no limit at all —
   * one request there becomes up to 200 concurrent database transactions.
   *
   * Configurable for the same reason the global limit is: the test suite fires
   * more bursts in a few seconds than any human will, and without a knob the
   * suite would be asserting against the rate limiter instead of the ledger.
   * Raising it for a test run is legitimate; the defaults are what ships.
   */
  CHAOS_SESSION_RATE_MAX: z.coerce.number().int().min(1).default(10),
  CHAOS_BURST_RATE_MAX: z.coerce.number().int().min(1).default(6),

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

  /**
   * Tracing is **off by default**, including in production.
   *
   * Not an oversight. The tracing SDK is the component most likely to leak
   * memory in this stack (see observability/tracing.ts), and a ledger that
   * stops accepting orders because the thing watching it ran the box out of
   * RAM is a worse outcome than having no waterfalls. It is turned on
   * deliberately, when there is something to look at.
   */
  // `.default(false)` — the boolean, not the string `'false'`. In Zod 4 a
  // default on a piped schema is the *output* type, so the string form is a
  // type error rather than a silently-truthy default.
  /**
   * Signing key for guest session cookies on the exchange.
   *
   * Its own secret, for the reason `CHAOS_TOKEN_SECRET` is: rotating it logs
   * every guest out, and that must not also invalidate webhook signatures.
   *
   * Required in production. With a published fallback anyone can mint a cookie
   * for any guest id they can name.
   */
  GUEST_SESSION_SECRET: z.string().min(16).optional(),

  /**
   * Guest accounts one IP may create per hour.
   *
   * Each one is two accounts, a participant and a funded ledger transaction
   * that — `entries` being append-only — can never be removed. An unbounded
   * "enter as guest" button is a way to grow the ledger for free.
   */
  EXCHANGE_GUEST_RATE_MAX: z.coerce.number().int().min(1).default(20),

  /**
   * Run the market-making bots in this process.
   *
   * **Off by default**, and that default is load-bearing: the bots write real
   * ledger entries continuously, and a development database holding the seeded
   * dataset is the thing every evidence file was measured against. Bots are
   * something a deployment opts into, against a database meant for them.
   *
   * Safe to enable on more than one instance: the runner holds a session
   * advisory lock, so exactly one of them trades.
   */
  EXCHANGE_BOTS_ENABLED: boolish.default(false),

  /** How many bots. The first run creates their accounts. */
  EXCHANGE_BOT_COUNT: z.coerce.number().int().min(1).max(64).default(12),

  /**
   * Mean pause between one bot's actions, in milliseconds. Each pause is drawn
   * uniformly from 0.5x to 1.5x of this.
   *
   * This is the knob for how fast the ledger grows. At the default, twelve bots
   * act about three times a second between them, and well under half of those
   * actions trade.
   */
  EXCHANGE_BOT_MEAN_INTERVAL_MS: z.coerce.number().int().min(100).default(4_000),

  OTEL_ENABLED: boolish.default(false),

  /**
   * OTLP/HTTP, not OTLP/gRPC. gRPC means a second protocol stack and a
   * `@grpc/grpc-js` dependency for a span volume that is a trickle at 2%
   * sampling; HTTP/protobuf over localhost is not the bottleneck.
   */
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().min(1).default('http://127.0.0.1:4318/v1/traces'),

  /**
   * Head sampling ratio. 0.02 by default — see the long note in
   * observability/tracing.ts on why this cannot be "sample on error".
   *
   * Settable to 1 for a short debugging window, which is the actual workflow:
   * raise it, reproduce, put it back.
   */
  OTEL_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.02),

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
export type Env = Omit<
  RawEnv,
  'ALLOW_FLAG_HEADERS' | 'WEBHOOK_SIGNING_SECRET' | 'CHAOS_TOKEN_SECRET' | 'GUEST_SESSION_SECRET'
> & {
  ALLOW_FLAG_HEADERS: boolean;
  WEBHOOK_SIGNING_SECRET: string;
  CHAOS_TOKEN_SECRET: string;
  GUEST_SESSION_SECRET: string;
};

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

  /**
   * The webhook secret is required in production and defaulted elsewhere.
   *
   * Defaulted rather than optional so the signature code has no "if there is no
   * secret" branch — a branch that, once it exists, is one bad deploy away from
   * accepting every unsigned request. The development value is deliberately
   * named so it cannot be mistaken for a real one.
   */
  if (env.NODE_ENV === 'production' && env.WEBHOOK_SIGNING_SECRET === undefined) {
    process.stderr.write('\nWEBHOOK_SIGNING_SECRET is required when NODE_ENV=production.\n\n');
    process.exit(78);
  }

  // Same rule, same reason: with a publicly-known fallback, the token gate on
  // an endpoint that opens 200 concurrent transactions is decorative.
  if (env.NODE_ENV === 'production' && env.CHAOS_TOKEN_SECRET === undefined) {
    process.stderr.write('\nCHAOS_TOKEN_SECRET is required when NODE_ENV=production.\n\n');
    process.exit(78);
  }

  // And again: a known cookie-signing key is no session at all.
  if (env.NODE_ENV === 'production' && env.GUEST_SESSION_SECRET === undefined) {
    process.stderr.write('\nGUEST_SESSION_SECRET is required when NODE_ENV=production.\n\n');
    process.exit(78);
  }

  // Defaulting one field from another cannot be expressed inside the schema
  // without making the field's type optional at every use site, so it happens
  // here, once, where both values are known.
  return {
    ...env,
    ALLOW_FLAG_HEADERS: env.ALLOW_FLAG_HEADERS ?? env.NODE_ENV !== 'production',
    WEBHOOK_SIGNING_SECRET:
      env.WEBHOOK_SIGNING_SECRET ?? 'whsec_development_only_not_a_real_secret',
    CHAOS_TOKEN_SECRET: env.CHAOS_TOKEN_SECRET ?? 'chaos_development_only_not_a_real_secret',
    GUEST_SESSION_SECRET: env.GUEST_SESSION_SECRET ?? 'guest_development_only_not_a_real_secret',
  };
}

export const env: Env = load(process.env);

/**
 * Exposed for tests, which need to assert the validation itself rejects things
 * without taking the process down. Returns the raw schema result — the
 * `ALLOW_FLAG_HEADERS` fallback is `load`'s job.
 */
export const parseEnv = (source: NodeJS.ProcessEnv) => schema.safeParse(source);
