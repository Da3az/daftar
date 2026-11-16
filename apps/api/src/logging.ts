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
   * Off: the one canonical line per request carries everything, and pino's
   * per-request child-logger lines would double the volume while splitting the
   * story of a single request across two records.
   */
  serializers: {},
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
