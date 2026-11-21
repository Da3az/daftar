import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  createSerializerCompiler,
  jsonSchemaTransform,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from '@fastify/type-provider-zod';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { env } from './env.ts';
import { logger } from './logging.ts';
import { FlagHeaderError } from './flags.ts';
import { requestContextPlugin } from './plugins/request-context.ts';
import { metricsPlugin } from './plugins/metrics.ts';
import { fastifyTracingPlugin } from './observability/tracing.ts';
import { createDatabase, type Database } from './db/pool.ts';
import { healthRoutes } from './routes/health.ts';
import { accountRoutes } from './routes/accounts.ts';
import { orderRoutes } from './routes/orders.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { reportRoutes } from './routes/reports.ts';
import { chaosRoutes } from './routes/chaos.ts';
import { exchangeRoutes } from './routes/exchange.ts';
import { OPENAPI_DOCUMENT } from './openapi/document.ts';

declare module 'fastify' {
  interface FastifyInstance {
    pool: pg.Pool;
    db: Database;
  }
}

/**
 * JSON has no integer type wide enough for an int8, so every amount crosses the
 * wire as an **exact decimal string**. Response schemas declare those fields as
 * `z.string()` and handlers format through `@daftar/money`, which is what makes
 * the contract honest.
 *
 * This replacer is a net under that, not a feature: if a bigint ever reaches
 * serialization it becomes its exact decimal digits rather than throwing
 * `TypeError: Do not know how to serialize a BigInt` from inside the serializer.
 * A throw there surfaces as a 500 with no useful body, which is a bad way to
 * discover a missing `formatCash` call.
 */
function bigintReplacer(this: unknown, _key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

const serializerCompiler = createSerializerCompiler({ replacer: bigintReplacer });

export interface BuildAppOptions {
  pool: pg.Pool;
  /**
   * Override the logger. Tests pass a silent or capturing pino instance.
   *
   * Typed `FastifyBaseLogger`, not pino's `Logger`: that is the interface
   * Fastify actually consumes, and pino's own `Logger` carries custom-level
   * generics that do not unify with it under `exactOptionalPropertyTypes`.
   *
   * Also note it is `?: FastifyBaseLogger` and not `: FastifyBaseLogger | false`.
   * A `loggerInstance` whose type includes `undefined` widens the options object
   * enough that TypeScript selects Fastify's *http2-secure* overload, and
   * `buildApp` then returns an instance typed against `Http2SecureServer`.
   */
  loggerOverride?: FastifyBaseLogger;
}

/** The concrete instance type, with the Zod type provider attached. */
export type App = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export async function buildApp(options: BuildAppOptions): Promise<App> {
  const app = Fastify({
    loggerInstance: options.loggerOverride ?? logger,

    /**
     * Fastify's own per-request "incoming request" / "request completed" pair is
     * switched off. This repo emits exactly one canonical line per request
     * instead: two lines per request double the volume and split one story
     * across two records that then have to be joined by request id.
     *
     * Configured through `logController` rather than the top-level
     * `disableRequestLogging` / `requestIdLogLabel` options — both are deprecated
     * as of Fastify 5.12 and slated for removal in 6, and the top-level form
     * emits an FSTDEP023 warning on every boot.
     *
     * `requestIdLogLabel` is set to `request_id` so Fastify's own id field and
     * the canonical line's field are the same key. Left at the default `reqId`,
     * every log line carried the same UUID twice under two names.
     */
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'request_id',
    }),

    genReqId: (req) => {
      // Trust an inbound request id so a trace survives the reverse proxy, but
      // bound its length: an unbounded header value ends up in every log line
      // for that request and is a cheap way to inflate someone's log bill.
      const header = req.headers['x-request-id'];
      const candidate = Array.isArray(header) ? header[0] : header;
      if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 64) {
        return candidate;
      }
      return crypto.randomUUID();
    },

    /**
     * 1 MiB. Orders are tiny; webhook payloads are small. A limit well below the
     * default means a malformed or hostile body is rejected before it is parsed.
     *
     * Note for Phase 4: this does *not* give us the raw body. Fastify discards
     * the raw bytes after the JSON parser runs, so webhook signature
     * verification will need its own content-type parser that keeps the buffer.
     * Parsing first and re-serialising to check a signature is the classic bug —
     * key order and whitespace are not preserved, so the HMAC will not match.
     */
    bodyLimit: 1_048_576,

    trustProxy: env.NODE_ENV === 'production',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('pool', options.pool);
  app.decorate('db', createDatabase(options.pool));

  /**
   * The pool's idle-client 'error' event is handled in createPool so the process
   * cannot be taken down by a database restart. Here it also gets logged, now
   * that there is a logger to log it with.
   */
  options.pool.on('error', (err) => {
    app.log.error({ err, sqlstate: (err as { code?: string }).code ?? null }, 'idle client error');
  });

  /**
   * Registered first, and awaited.
   *
   * `@fastify/otel` wraps route handlers and lifecycle hooks as they are
   * defined, so it has to be in place before any route or plugin that adds one.
   * Registering it after the routes produces a server with no handler spans and
   * no indication that anything is missing.
   */
  await app.register(fastifyTracingPlugin());

  await app.register(requestContextPlugin);
  await app.register(metricsPlugin);

  await app.register(cors, {
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: false,
  });

  /**
   * A global per-IP limit, generous by default and configurable.
   *
   * Configurable for a specific reason: a k6 run originates from one IP, so it
   * is indistinguishable from the abuse this limit exists to stop. The Phase 1
   * harness's 500 virtual users tripped the default and the run measured the
   * rate limiter rather than the ledger. Evidence runs raise
   * `RATE_LIMIT_MAX` and record the value they used.
   *
   * The real protection is on the Phase 8 burst endpoint, which gets a much
   * tighter limit of its own: a public endpoint that spawns server-side
   * concurrency is a denial-of-service amplifier if it is not capped.
   */
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // Trust the proxy's client address only where trustProxy is also on.
    // Normalised as the plugin's default key is: an IPv6 client is keyed by its
    // /64, which one connection can rotate through freely, and an IPv4-mapped
    // address by its IPv4 form.
    keyGenerator: (req) => normalizeIP(req.ip),
    // Health checks are what a load balancer and a container orchestrator use to
    // decide whether this instance is alive. Rate-limiting them means a traffic
    // spike gets an instance marked unhealthy and removed, which converts a
    // throughput problem into an outage.
    allowList: (req) => req.url.startsWith('/health/') || req.url === '/metrics',
  });

  await app.register(swagger, {
    openapi: OPENAPI_DOCUMENT,
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  /*
   * `error` is annotated explicitly. With a type provider attached, Fastify
   * types the error-handler's first parameter as `unknown`, which is honest —
   * anything can be thrown — but means every property access needs a narrowing
   * step. FastifyError is the shape Fastify actually delivers for everything it
   * routes through here, and the `code`/`statusCode` reads below are guarded
   * anyway.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const ctx = request.ctx;

    // A PostgreSQL error carries a five-character SQLSTATE in `code`. Recording
    // it on the context is what lets the canonical log line distinguish 40001
    // (serialization_failure) from 40P01 (deadlock_detected) — two conditions
    // that both surface as a 409 and are constantly conflated.
    const sqlstate = (error as { code?: unknown }).code;
    if (typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)) {
      ctx.sqlstate = sqlstate;
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: 'validation_failed',
        message: 'request did not match the schema',
        issues: error.validation.map((issue) => ({
          path: issue.instancePath,
          message: issue.message ?? 'invalid',
        })),
      });
      return;
    }

    if (isResponseSerializationError(error)) {
      // A response that does not match its own declared schema is our bug, not
      // the caller's, and must be loud rather than coerced into something that
      // happens to serialise.
      app.log.error({ err: error, route: error.method }, 'response schema violation');
      reply.status(500).send({ error: 'internal_error', message: 'response schema violation' });
      return;
    }

    if (error instanceof FlagHeaderError) {
      reply.status(400).send({ error: 'invalid_flag_header', message: error.message });
      return;
    }

    const status = error.statusCode ?? 500;

    /*
     * A rate-limit refusal, from `@fastify/rate-limit`. Its own body says only
     * "retry in 1 minute"; this one names the condition and says when, in
     * seconds, copied from the `Retry-After` header the plugin set before it
     * threw (Fastify keeps headers on the error path).
     */
    if (status === 429) {
      const retryAfter = Number(reply.getHeader('retry-after'));
      reply.status(429).send({
        error: 'rate_limited',
        message: error.message,
        ...(Number.isFinite(retryAfter) && retryAfter >= 0
          ? { retryAfterSeconds: Math.ceil(retryAfter) }
          : {}),
      });
      return;
    }

    if (status >= 500) {
      app.log.error({ err: error, sqlstate: ctx.sqlstate }, 'unhandled error');
      reply.status(status).send({ error: 'internal_error', message: 'internal error' });
      return;
    }

    reply.status(status).send({ error: error.code ?? 'request_failed', message: error.message });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: 'not_found', message: `${request.method} ${request.url}` });
  });

  await app.register(healthRoutes);
  await app.register(accountRoutes);
  await app.register(orderRoutes);
  await app.register(webhookRoutes);
  await app.register(reportRoutes);
  await app.register(chaosRoutes);
  await app.register(exchangeRoutes);

  return app;
}
