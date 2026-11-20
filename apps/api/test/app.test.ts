import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { FLAG_HEADERS } from '../src/flags.ts';
import { useTestDatabase } from './support/test-database.ts';

const ctx = useTestDatabase();

/**
 * Capture the canonical log lines by giving pino a writable stream. Asserting on
 * the real emitted JSON rather than spying on a method: the thing under test is
 * the shape of the line an operator will grep, and a spy would pass even if the
 * serializers mangled it.
 */
interface Captured {
  lines: Record<string, unknown>[];
  clear: () => void;
}

function capturingLogger(): { logger: FastifyBaseLogger; captured: Captured } {
  const lines: Record<string, unknown>[] = [];

  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const raw of chunk.toString('utf8').split('\n')) {
        if (raw.trim().length === 0) continue;
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
      callback();
    },
  });

  return {
    logger: pino({ level: 'info', base: null }, stream),
    captured: {
      lines,
      clear: () => {
        lines.length = 0;
      },
    },
  };
}

let app: App;
let captured: Captured;

beforeAll(async () => {
  const { logger, captured: c } = capturingLogger();
  captured = c;
  app = await buildApp({ pool: ctx.pool, loggerOverride: logger });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const canonical = (): Record<string, unknown>[] =>
  captured.lines.filter((l) => l['msg'] === 'request');

describe('health', () => {
  it('GET /health/live needs no database', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    expect(typeof res.json<{ uptimeSeconds: number }>().uptimeSeconds).toBe('number');
  });

  it('GET /health/ready proves int8 round-trips as a bigint', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { database: true, bigintTypeParser: true },
      int8Probe: {
        // 2^63 - 1, exact, as a decimal string on the wire.
        value: '9223372036854775807',
        runtimeType: 'bigint',
      },
    });
  });
});

describe('the canonical log line', () => {
  it('emits exactly one line per request', async () => {
    captured.clear();
    await app.inject({ method: 'GET', url: '/health/live' });

    expect(canonical()).toHaveLength(1);
    // And nothing else: Fastify's own incoming/completed pair is switched off.
    expect(captured.lines).toHaveLength(1);
  });

  it('carries every field an operator needs to reconstruct the request', async () => {
    captured.clear();
    await app.inject({ method: 'GET', url: '/health/ready' });

    const line = canonical()[0]!;

    expect(Object.keys(line).sort()).toEqual(
      [
        'aborted',
        'account_id',
        'db_calls',
        'db_ms',
        'duration_ms',
        'level',
        'method',
        'mode',
        'msg',
        'request_id',
        'retry_count',
        'route',
        'span_id',
        'sqlstate',
        'status',
        'time',
        'trace_id',
      ].sort(),
    );

    /**
     * Present and `null`, not absent.
     *
     * Tracing is off in tests, and the correlation keys still have to be on the
     * line — a log consumer that indexes `trace_id` should see one stable shape
     * whether or not the span was sampled. See `traceIds()` in
     * src/plugins/metrics.ts.
     */
    expect(line.trace_id).toBeNull();
    expect(line.span_id).toBeNull();

    expect(line).toMatchObject({
      method: 'GET',
      route: '/health/ready',
      status: 200,
      aborted: false,
      retry_count: 0,
      sqlstate: null,
      account_id: null,
      mode: 'serializable',
    });
  });

  it('records database time and call count', async () => {
    captured.clear();
    await app.inject({ method: 'GET', url: '/health/ready' });

    const line = canonical()[0]!;
    expect(line['db_calls']).toBe(1);
    expect(line['db_ms']).toBeGreaterThan(0);
    // Database time is a subset of total time, by construction.
    expect(line['db_ms']).toBeLessThanOrEqual(line['duration_ms'] as number);
  });

  it('db_ms stays 0 on a route that touches nothing', async () => {
    captured.clear();
    await app.inject({ method: 'GET', url: '/health/live' });

    expect(canonical()[0]).toMatchObject({ db_calls: 0, db_ms: 0 });
  });

  it('reports the request id, taken from x-request-id when supplied', async () => {
    captured.clear();
    await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'trace-from-the-proxy' },
    });

    expect(canonical()[0]?.['request_id']).toBe('trace-from-the-proxy');
  });

  it('ignores an over-long inbound request id', async () => {
    // An unbounded header value would end up in every line for that request.
    captured.clear();
    await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'x'.repeat(65) },
    });

    const id = canonical()[0]?.['request_id'];
    expect(id).not.toBe('x'.repeat(65));
    expect(String(id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('names the per-request mode, including an active naive path', async () => {
    captured.clear();
    await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: {
        [FLAG_HEADERS.concurrencyMode]: 'pessimistic',
        [FLAG_HEADERS.naiveLostUpdate]: 'true',
      },
    });

    expect(canonical()[0]?.['mode']).toBe('pessimistic+naive_lost_update');
  });

  it('is still emitted for a 404', async () => {
    captured.clear();
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(res.statusCode).toBe(404);
    expect(canonical()[0]).toMatchObject({ status: 404, route: '/does-not-exist' });
  });

  it('never writes a raw bigint, which would throw inside the logger', async () => {
    // JSON.stringify(1n) throws TypeError. In the canonical-line design that
    // throw happens in a finally block, where it would replace the real error.
    captured.clear();
    await app.inject({ method: 'GET', url: '/health/ready' });

    expect(() => JSON.stringify(canonical()[0])).not.toThrow();
  });
});

describe('error handling', () => {
  it('rejects an invalid flag header with a 400 naming it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { [FLAG_HEADERS.concurrencyMode]: 'optimistic' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_flag_header' });
    expect(res.json<{ message: string }>().message).toContain(FLAG_HEADERS.concurrencyMode);
  });

  it('a 404 body is shaped, not an HTML page', async () => {
    const res = await app.inject({ method: 'POST', url: '/nope' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({ error: 'not_found', message: 'POST /nope' });
  });
});

/**
 * Only the parts of the document these tests actually read. A fuller OpenAPI
 * type would be noise, and `Record<string, never>` plus index access defeats the
 * no-unsafe-member-access rule for no benefit.
 */
interface OpenApiDocument {
  openapi: string;
  info: { title: string; description: string };
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<
          string,
          { content: Record<string, { schema: { properties: Record<string, unknown> } }> }
        >;
      }
    >
  >;
}

describe('the generated OpenAPI document', () => {
  const fetchDocument = async (): Promise<OpenApiDocument> => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    return res.json<OpenApiDocument>();
  };

  it('is served and describes the live routes', async () => {
    const doc = await fetchDocument();

    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.title).toBe('Daftar API');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/health/live', '/health/ready']),
    );
  });

  it('is generated from the Zod schemas, so response shapes are in it', async () => {
    const doc = await fetchDocument();

    const schema =
      doc.paths['/health/ready']?.['get']?.responses['200']?.content['application/json']?.schema;

    // If this is undefined, the Zod schema stopped reaching the document — which
    // is the single-source-of-truth property silently breaking.
    expect(schema).toBeDefined();
    expect(Object.keys(schema!.properties).sort()).toEqual(['checks', 'int8Probe', 'status']);
  });

  it('warns in prose that amounts are decimal strings, not JSON numbers', async () => {
    // The contract is only honest if it is stated where a consumer will read it.
    const doc = await fetchDocument();

    expect(doc.info.description).toContain('minor units');
    expect(doc.info.description).toContain('exact decimal');
    expect(doc.info.description).toContain('Demo only');
  });
});
