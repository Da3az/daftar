import { pino, type Logger, type LoggerOptions } from 'pino';
import { env } from './env.ts';

/**
 * ## Why bigint needs a serializer
 *
 * `JSON.stringify(1n)` throws `TypeError: Do not know how to serialize a
 * BigInt`. Every amount in this system is a bigint, so a log line that includes
 * one would throw *inside the logger* — which, in the canonical-log-line design,
 * is inside a `finally` block, where a throw replaces the real error with a
 * serialization error and loses the original.
 *
 * Amounts are therefore rendered as **exact decimal strings** in logs, with the
 * same `n`-free representation used on the wire. A log line is a string artefact;
 * precision is preserved by rendering the integer, not by hoping the consumer
 * has a bigint type.
 */
function replaceBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(replaceBigInts);

  /**
   * **Errors are handled explicitly, and this is not a nicety.**
   *
   * The first version of this function fell through to the generic object
   * branch below for everything non-primitive. `Object.entries(new Error('x'))`
   * is `[]` — `message` and `stack` are non-enumerable own properties — so
   * every error this logger touched was rebuilt as `{}`.
   *
   * The result was `{"level":"error","err":{},"msg":"unhandled error"}` for
   * every unhandled exception in the service. Found while debugging an
   * unrelated 500: the log said an error had happened and nothing whatsoever
   * about what it was. A logging layer that silently discards error detail is
   * worse than no logging, because it is trusted.
   *
   * Compounding it, `serializers: {}` below replaced pino's default `err`
   * serializer, so nothing else was going to rescue the Error either.
   */
  if (value instanceof Error) {
    const serialised: Record<string, unknown> = {
      type: value.name,
      message: value.message,
      stack: value.stack,
    };

    // Own enumerable properties carry the detail that matters most here: pg
    // puts `code` (the SQLSTATE), `constraint`, `detail` and `table` on its
    // errors, and losing those would make a constraint violation unreadable.
    for (const [k, v] of Object.entries(value)) {
      if (k in serialised) continue;
      serialised[k] = replaceBigInts(v);
    }

    if (value.cause !== undefined) serialised['cause'] = replaceBigInts(value.cause);

    return serialised;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = replaceBigInts(v);
    }
    return out;
  }

  return value;
}

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-daftar-burst-token"]',
  'req.headers["x-daftar-signature"]',
  'headers.authorization',
  'headers.cookie',
  'secret',
  '*.secret',
  'signingSecret',
  'password',
  '*.password',
];

const base: LoggerOptions = {
  level: env.LOG_LEVEL,

  /**
   * `base: null` drops pino's default `pid` and `hostname`. In a container both
   * are noise — the pid is always 1 and the hostname is a random id — and
   * dropping them keeps the canonical line scannable.
   */
  base: null,

  /** ISO-8601 rather than epoch millis, so a log line is readable unaided. */
  timestamp: pino.stdTimeFunctions.isoTime,

  redact: { paths: redactPaths, censor: '[redacted]' },

  formatters: {
    level: (label) => ({ level: label }),
    log: (object) => replaceBigInts(object) as Record<string, unknown>,
  },

  /**
   * `err` is serialised by `replaceBigInts` above, which handles Error
   * explicitly. Nothing is overridden here.
   *
   * It previously read `serializers: {}`, intending "no per-request child
   * serializers". That also removed pino's default `err` serializer, which was
   * half of why errors logged as `{}`. The volume concern it was aimed at is
   * handled by `logController.disableRequestLogging` in app.ts, which is the
   * right place for it.
   */
};

export function createLogger(): Logger {
  if (!env.LOG_PRETTY) return pino(base);

  return pino({
    ...base,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'level' },
    },
  });
}

export const logger: Logger = createLogger();

/** Exported for the test that asserts bigints never reach JSON.stringify raw. */
export { replaceBigInts };
