import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
// Named, not default: the package is CommonJS and declares `export = ` on a
// namespace, so a default import resolves to the namespace object rather than
// the class and `new` on it is not constructable.
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions/incubating';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-node';

/**
 * # OpenTelemetry tracing
 *
 * ## Instrumentations are hand-picked, and that is a memory decision
 *
 * `@opentelemetry/auto-instrumentations-node` is deliberately **not** used. It
 * pulls in every instrumentation it knows about, including
 * `instrumentation-fs`, which patches every filesystem call in the process.
 * Node reads files constantly — module resolution, TLS certificates, `/proc`
 * polling — and each one becomes a span object. It is widely reported to add
 * hundreds of megabytes of RSS at startup on its own, for data nobody reads.
 *
 * Three instrumentations, chosen for the three spans that answer the question
 * "where did the time go": `http` (inbound and outbound), `fastify` (which
 * handler), `pg` (which query). Nothing else.
 *
 * ## Fastify spans come from `@fastify/otel`, and finding that out took a trace
 *
 * The first version used `@opentelemetry/instrumentation-fastify`. It
 * installed, it type-checked, the SDK started with no warning, and `pg` and
 * `http` spans arrived correctly. The Fastify spans simply were not there, and
 * the inbound HTTP span was named `POST` rather than `POST /v1/orders` —
 * because it is the Fastify instrumentation that contributes the route to the
 * HTTP span's name.
 *
 * `npm view @opentelemetry/instrumentation-fastify deprecated` says it:
 *
 *   Deprecated in favor of @fastify/otel, maintained by the Fastify authors.
 *
 * Nothing in the install surfaced that. The lesson generalises past this
 * package: an instrumentation that produces no spans fails *silently* by
 * design, so "it started without errors" is not evidence that it works. The
 * only check that counts is looking at a trace and confirming the spans you
 * expected are in it.
 *
 * ### The version that cannot be installed
 *
 * `@fastify/otel@1.x` peers on `@opentelemetry/api >=1.10.0 <1.11.0`, while
 * `@opentelemetry/sdk-trace-node@2.12.0` — the current stable SDK — peers on
 * `>=1.0.0 <1.10.0`. Those ranges do not intersect, so 1.x is uninstallable
 * alongside the SDK without `--legacy-peer-deps`, which would resolve a
 * conflict that is real rather than cosmetic. Pinned to **0.21.4**, whose peer
 * is `^1.9.0` and therefore satisfiable. Revisit when the SDK's API peer moves
 * to 1.10.
 *
 * ### It is a plugin, not an auto-instrumentation
 *
 * Unlike the other two it does not patch anything at module load; it is
 * registered into the Fastify instance explicitly (see app.ts). It is still
 * listed in `instrumentations` below so the SDK wires its tracer provider — a
 * provider it would otherwise not have, which is a second way to get zero
 * spans and no error.
 *
 * ## The `import-in-the-middle` trap
 *
 * ESM instrumentation works by registering a loader hook, and **every
 * instrumentation package plus the hook registration must share one copy of
 * `import-in-the-middle`**. With two copies, one registers the hook and the
 * others patch a module graph that is never consulted — so instrumentation
 * silently does nothing. No error, no warning, just empty traces.
 *
 * Verified rather than assumed, with `npm ls import-in-the-middle` — every
 * entry `deduped` against one copy at the root. A test asserts the single-copy
 * property so an `npm install` that un-dedupes it fails CI rather than quietly
 * producing empty traces.
 *
 * ## Versions are pinned exact
 *
 * The OpenTelemetry JS packages move fast and their cross-package peer ranges
 * are strict. A caret range here is how a working trace pipeline becomes an
 * empty one after an unrelated `npm install`.
 */

/**
 * Head sampling at 2%.
 *
 * 100% sampling fills the disk. At the Phase 3 benchmark's measured 1,718
 * orders/s, retaining every span is roughly 150 million spans a day from one
 * endpoint. Tracing exists to diagnose shapes; the ledger itself is the audit
 * trail.
 *
 * ## Why there is no "always sample on error" here, despite wanting one
 *
 * A head sampler decides when the span **starts**. The error has not happened
 * yet. There is no way for `shouldSample` to know that this request will fail,
 * so "always sample on error" is not expressible in head sampling at all — and
 * a first draft of this file implemented a custom sampler that pretended
 * otherwise, checking an attribute that nothing could have set yet.
 *
 * Getting it properly needs one of:
 *
 *  - **Tail sampling**, in a collector that buffers every span until its trace
 *    completes and then decides. That is the correct answer and it is ruled out
 *    by the box: the buffer is the entire span volume held in memory for the
 *    trace-completion window, which is the resource cost this deployment cannot
 *    pay.
 *  - **A forced flag set before the work**, which only helps when the caller
 *    already knows the request is interesting. A retry is the one case here
 *    that qualifies — the second attempt of a `serializable` write is
 *    known-interesting at the moment it starts — and the `ParentBasedSampler`
 *    below is what would make it work, by keeping any span started under an
 *    explicitly-sampled parent. Not wired up: `retry_count` is already on the
 *    canonical log line and on `daftar_ledger_retries_total`, so the signal is
 *    not missing, only the waterfall for it.
 *
 * What covers the gap for genuine errors is the canonical log line, which
 * carries `trace_id` whether or not the span was sampled. An unsampled failure
 * is still findable — by log search rather than by waterfall. That is a real
 * reduction in capability and it is written down rather than papered over:
 * **the README says the waterfall shown is sampled.**
 */
const SAMPLE_RATIO = 0.02;

export interface TracingOptions {
  serviceName?: string;
  serviceVersion?: string;
  environment: string;
  /** OTLP/HTTP endpoint, e.g. http://127.0.0.1:4318/v1/traces */
  endpoint: string;
  sampleRatio?: number;
}

let sdk: NodeSDK | undefined;

/**
 * The Fastify instrumentation, held as a module singleton.
 *
 * It has to be reachable from two places — `startTracing` lists it so the SDK
 * attaches a tracer provider, and `buildApp` registers its plugin — and both
 * must get the *same* instance. Two instances means the one holding the
 * provider is not the one wired into Fastify, which produces no spans and no
 * error.
 *
 * `registerOnInitialization: false` because this repo registers the plugin
 * explicitly in app.ts. The automatic path patches `fastify` at module load,
 * which would apply to the app Vitest builds per test file as well, and tracing
 * is not something tests should silently acquire.
 */
const fastifyInstrumentation = new FastifyOtelInstrumentation({
  registerOnInitialization: false,
  // Same two prefixes the HTTP instrumentation ignores. Scrape and probe
  // traffic is constant, says nothing, and would dominate any sample.
  ignorePaths: (route) => route.url.startsWith('/metrics') || route.url.startsWith('/health'),
});

/**
 * The Fastify plugin, for `buildApp` to register.
 *
 * Returned unconditionally — the plugin is harmless with no tracer provider
 * attached, and making registration conditional on `OTEL_ENABLED` would mean
 * the request pipeline differs in shape between a traced and an untraced run.
 * That is the kind of difference that makes a latency number from one
 * configuration not comparable with the other.
 */
export const fastifyTracingPlugin = (): ReturnType<typeof fastifyInstrumentation.plugin> =>
  fastifyInstrumentation.plugin();

/**
 * Start tracing. Must be called **before** the application imports anything it
 * wants instrumented — ESM patching happens at module load, so a late start
 * silently instruments nothing.
 */
export function startTracing(options: TracingOptions): void {
  if (sdk) return;

  /**
   * `ParentBasedSampler` wrapping the ratio sampler, not the ratio sampler
   * alone. Without it a sampled parent can have unsampled children, and the
   * trace arrives at the backend with holes in it — which reads as an
   * application bug rather than a sampling configuration.
   *
   * It is also what makes the retry case work: a span started under an
   * explicitly-sampled parent context is kept, regardless of the ratio.
   */
  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(options.sampleRatio ?? SAMPLE_RATIO),
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName ?? 'daftar-api',
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.1.0',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
    }),

    sampler,

    traceExporter: new OTLPTraceExporter({ url: options.endpoint }),

    /**
     * Hand-picked. See the note above on why `auto-instrumentations-node` and
     * especially `instrumentation-fs` are absent.
     */
    instrumentations: [
      new HttpInstrumentation({
        /**
         * The metrics and health endpoints are scraped every few seconds
         * forever. Tracing them produces a constant stream of spans that say
         * nothing and dominate any sample.
         */
        ignoreIncomingRequestHook: (request) => {
          const url = request.url ?? '';
          return url.startsWith('/metrics') || url.startsWith('/health');
        },
      }),

      // Listed so the SDK sets its tracer provider. The actual patching
      // happens when app.ts registers `fastifyTracingPlugin()`.
      fastifyInstrumentation,

      new PgInstrumentation({
        /**
         * Off. `enhancedDatabaseReporting` puts parameter *values* on the span,
         * and in this system the parameters are account ids and amounts. That
         * is customer financial data in a tracing backend, which is the same
         * class of mistake as labelling a metric by account id.
         */
        enhancedDatabaseReporting: false,
        requireParentSpan: true,
      }),
    ],
  });

  sdk.start();
}

/** Flush and stop. Called from the shutdown path so in-flight spans are not lost. */
export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}

export const isTracingStarted = (): boolean => sdk !== undefined;
