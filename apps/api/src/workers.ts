import { createServer, type Server } from 'node:http';
import type { Worker } from 'bullmq';
import { env } from './env.ts';
import { logger } from './logging.ts';

/**
 * # The worker process
 *
 * Everything that is not answering an HTTP request: the outbox relay, the
 * event-log consumers, the BullMQ workers. A separate process from the API
 * because the API already saturates one core under load (README, result 4),
 * and a consumer replaying a month of events must not take that core from the
 * order path.
 *
 * Every component has its own flag and is **off by default**, for the bots'
 * reason: they write. Start with `npm run dev:workers`.
 *
 * ## Shutdown order
 *
 * 1. consumers — they may be mid-`add()` of a job, or mid-transaction;
 * 2. the outbox relay — a cycle in progress holds claimed rows to settle;
 * 3. reconcile sweeps and BullMQ workers — `close()` waits for active jobs;
 * 4. queues, the producer, then the pool everything above was using.
 *
 * Each stage gets a deadline. A job that will not finish inside it is left to
 * BullMQ's stalled-job check (30 s lock), which hands it to the next worker:
 * at-least-once, again, and the job is idempotent for exactly that reason.
 */

const { createPool } = await import('./db/pool.ts');
const { registry, metricsText, metricsContentType } = await import('./observability/metrics.ts');

registry.setDefaultLabels({ service: 'daftar-workers' });

const pool = createPool({
  connectionString: env.DATABASE_URL,
  max: env.WORKERS_DB_POOL_MAX,
  applicationName: 'daftar-workers',
});

const { topicNames, groupNames } = await import('./events/topics.ts');
const topics = topicNames(env.KAFKA_NAMESPACE);
const groups = groupNames(env.KAFKA_NAMESPACE);
const kafka = { brokers: env.KAFKA_BROKERS, clientId: `daftar-workers-${String(process.pid)}` };
const redis = { url: env.REDIS_URL, prefix: env.BULLMQ_PREFIX };

type Stoppable = { name: string; stop: () => Promise<void> };
const stages: Stoppable[][] = [[], [], [], []];

const needsProducer = env.CONSUMERS_ENABLED || env.OUTBOX_PUBLISHER === 'kafka';
const producer = needsProducer
  ? (await import('./events/kafka.ts')).createProducer({
      ...kafka,
      clientId: `${kafka.clientId}-producer`,
    })
  : null;

const queues =
  env.JOBS_ENABLED || env.CONSUMERS_ENABLED
    ? (await import('./jobs/queues.ts')).createQueues(redis)
    : null;

/* ------------------------------------------------------------- consumers */

if (env.CONSUMERS_ENABLED && producer) {
  const { runConsumer } = await import('./events/consumer.ts');
  const { applyActivity } = await import('./events/consumers/activity.ts');
  const { applyPosition, isTradeEvent } = await import('./events/consumers/positions.ts');
  const { markDirty, startReconcileSweeps } = await import('./events/consumers/reconciler.ts');

  const options = { pool, kafka, topics, producer, log: logger };

  const consumers = [
    runConsumer(options, {
      name: 'activity',
      groupId: groups.activity,
      types: () => true,
      startFrom: 'earliest',
      handler: { kind: 'transactional', apply: applyActivity },
    }),
    runConsumer(options, {
      name: 'positions',
      groupId: groups.positions,
      types: isTradeEvent,
      startFrom: 'earliest',
      handler: { kind: 'transactional', apply: applyPosition },
    }),
    runConsumer(options, {
      name: 'reconciler',
      groupId: groups.reconciler,
      types: isTradeEvent,
      startFrom: 'earliest',
      handler: { kind: 'transactional', apply: markDirty },
    }),
  ];
  consumers.forEach((c, i) => stages[0]!.push({ name: `consumer-${String(i)}`, stop: c.stop }));

  const sweeps = startReconcileSweeps(pool, { intervalMs: env.RECONCILE_INTERVAL_MS, log: logger });
  stages[2]!.push({ name: 'reconcile-sweeps', stop: sweeps.stop });
}

/* ---------------------------------------------------------- outbox relay */

if (env.OUTBOX_WORKER_ENABLED) {
  const { startOutboxWorker } = await import('./outbox/runner.ts');
  const relay = startOutboxWorker(pool, {
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    log: logger,
    batchSize: env.OUTBOX_BATCH_SIZE,
    workerId: `workers-${String(process.pid)}`,
    publisher:
      env.OUTBOX_PUBLISHER === 'kafka' && producer
        ? { kind: 'kafka', producer, topic: topics.events }
        : { kind: 'direct' },
  });
  stages[1]!.push({ name: 'outbox', stop: relay.stop });
}

/* ---------------------------------------------------------- BullMQ workers */

const workers: Worker[] = [];

if (env.JOBS_ENABLED && queues) {
  const { declareMaintenanceSchedules, startMaintenanceWorker } =
    await import('./jobs/maintenance.ts');
  await declareMaintenanceSchedules(queues, { equityEveryMs: env.EQUITY_SNAPSHOT_EVERY_MS });
  workers.push(startMaintenanceWorker(pool, redis, logger));
}

for (const worker of workers) {
  // An EventEmitter 'error' with no listener takes the process down. A Valkey
  // blip is not a reason to exit; the client reconnects.
  worker.on('error', (err) => logger.warn({ err, queue: worker.name }, 'bullmq worker error'));
  stages[2]!.push({ name: `worker-${worker.name}`, stop: () => worker.close() });
}

/* ---------------------------------------------------------------- metrics */

let metricsServer: Server | null = null;
if (env.WORKERS_METRICS_PORT > 0) {
  metricsServer = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metricsText()
      .then((body) => res.writeHead(200, { 'content-type': metricsContentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  // Loopback only: scraped by a Prometheus on the same host.
  metricsServer.listen(env.WORKERS_METRICS_PORT, '127.0.0.1');
}

logger.info(
  {
    outbox: env.OUTBOX_WORKER_ENABLED ? env.OUTBOX_PUBLISHER : 'off',
    consumers: env.CONSUMERS_ENABLED,
    jobs: env.JOBS_ENABLED,
    market_ticker: env.MARKET_TICKER_ENABLED,
  },
  'worker process started',
);

/* --------------------------------------------------------------- shutdown */

const STAGE_DEADLINE_MS = 20_000;

async function withDeadline(name: string, work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn({ component: name }, 'shutdown deadline passed; moving on');
      resolve();
    }, STAGE_DEADLINE_MS);
  });
  try {
    await Promise.race([
      work.catch((err: unknown) => logger.warn({ err, component: name }, 'stop failed')),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker process shutting down');

  try {
    for (const stage of stages) {
      await Promise.all(stage.map((s) => withDeadline(s.name, s.stop())));
    }
    if (queues) await (await import('./jobs/queues.ts')).closeQueues(queues);
    await producer?.close();
    metricsServer?.close();
    await pool.end();
    logger.info('worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'worker shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection');
  process.exit(1);
});
