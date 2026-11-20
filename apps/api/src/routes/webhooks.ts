import { z } from 'zod';
import { parseCash } from '@daftar/money';
import type { FastifyPluginAsyncZod } from '@fastify/type-provider-zod';
import { env } from '../env.ts';
import { timed } from '../plugins/request-context.ts';
import { rawBodyPlugin } from '../webhooks/raw-body.ts';
import { SIGNATURE_HEADER, verify } from '../webhooks/signature.ts';
import {
  alreadySettledForObject,
  beginProcessing,
  ingest,
  settle,
  type InboundEvent,
} from '../webhooks/process.ts';
import { post } from '../ledger/post.ts';
import { webhookDeliveries, webhookDuplicates } from '../observability/metrics.ts';

/**
 * # `POST /v1/webhooks/:provider`
 *
 * A simulated funding and settlement provider. There is no real payment
 * account; `scripts/sign-webhook.mjs` produces correctly signed payloads,
 * including replays and out-of-window timestamps, so the whole surface is
 * exercisable without a third party.
 *
 * The order of operations is the substance of this route:
 *
 *   1. verify the signature over the **raw bytes** — nothing is trusted first
 *   2. parse and validate the payload
 *   3. `ingest` — the unique index decides whether this is a first delivery
 *   4. check whether the same *object* was already settled under another id
 *   5. `beginProcessing` — only one concurrent delivery may proceed
 *   6. do the ledger write, settling the event in the same transaction
 *
 * Step 1 is first because every value in the request is attacker-controlled
 * until the signature has vouched for it — including the timestamp the replay
 * window is checked against.
 */

const WebhookPayload = z.object({
  id: z.string().min(1).max(128).describe("The provider's event id."),
  type: z.enum(['funding.succeeded', 'payout.succeeded', 'order.settled']),
  /** The object this event is about. */
  objectId: z.string().min(1).max(128),
  /** Target account's external id. */
  accountId: z.string().min(1).max(128).optional(),
  /** Exact decimal string. Never a JSON number — see the OpenAPI description. */
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .optional(),
});

const WebhookAck = z.object({
  received: z.literal(true),
  eventId: z.string(),
  state: z.enum(['processed', 'failed', 'ignored']),
  duplicate: z.boolean(),
  deliveryCount: z.number().int(),
  transactionId: z.string().nullable(),
});

const WebhookRejection = z.object({
  received: z.literal(false),
  error: z.string(),
  message: z.string(),
});

type Outcome = z.infer<typeof WebhookAck> | z.infer<typeof WebhookRejection>;

const PROVIDERS = ['simbank'] as const;

export const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Scoped to this plugin, so only this route retains raw bytes. Retaining them
   * globally costs memory on every request and puts a copy of every payload on
   * a live object, where a heap dump would capture it.
   */
  await app.register(rawBodyPlugin);

  app.route({
    method: 'POST',
    url: '/v1/webhooks/:provider',
    schema: {
      tags: ['webhooks'],
      summary: 'Inbound provider event. HMAC-SHA256 over the raw body.',
      description: [
        '**Signature.** `' + SIGNATURE_HEADER + ': t=<unix>,v1=<hex>` where the',
        'HMAC-SHA256 is computed over `"{t}.{raw body}"` with the shared secret.',
        "Modelled on Stripe's scheme. Several `v1=` values are accepted so a",
        'secret rotation needs no downtime.',
        '',
        'The signature covers the **raw bytes**. Verifying against a',
        're-serialised body cannot work: a JSON round trip changes number',
        'formatting, whitespace, unicode escaping, duplicate keys and',
        'integer-like key order — and corrupts large integers outright.',
        '',
        '**Replay window.** +/-300s on the signed timestamp. A correctly signed',
        'but stale payload is recorded as a replay, not a forgery; the two are',
        'reported separately because they need different responses.',
        '',
        '**Idempotency.** `UNIQUE (provider, idempotency_key)` arbitrates. A',
        'replay arriving while the first delivery is still processing gets',
        '**409**, not 200 — answering 200 for work that has not finished is the',
        'bug this endpoint exists to avoid. The payload hash is stored, so the',
        'same key with a different body is detected and reported rather than',
        'silently accepted.',
        '',
        'Generate signed payloads with `node scripts/sign-webhook.mjs`.',
      ].join('\n'),
      params: z.object({ provider: z.enum(PROVIDERS) }),
      response: {
        200: WebhookAck,
        202: WebhookAck,
        400: WebhookRejection,
        401: WebhookRejection,
        409: WebhookRejection,
        422: WebhookRejection,
      },
    },
    handler: async (request, reply) => {
      const provider = request.params.provider;

      /**
       * The whole delivery, as one function with one return type.
       *
       * Wrapped rather than inlined so the metrics below have a **single**
       * accounting point. Nine `inc()` calls scattered across nine return
       * statements is how a metric quietly stops counting one branch, and the
       * branch it stops counting is invariably the interesting one.
       *
       * `outcome` is the rejection's `error` code or the ack's `state`, both of
       * which are closed sets — nine values between them. It is deliberately
       * finer-grained than the status code: `400` covers both a malformed
       * payload and a replay outside the window, and those are completely
       * different operational facts.
       */
      const deliver = async (): Promise<Outcome> => {
        const rawBody = request.rawBody ?? Buffer.alloc(0);
        const header = request.headers[SIGNATURE_HEADER];

        if (typeof header !== 'string') {
          reply.status(401);
          return {
            received: false as const,
            error: 'missing_signature',
            message: `${SIGNATURE_HEADER} header is required`,
          };
        }

        // STEP 1 — nothing below this line trusts anything from the request
        // until the signature has vouched for it.
        const verification = verify({
          secret: env.WEBHOOK_SIGNING_SECRET,
          rawBody,
          header,
          nowSeconds: Math.floor(Date.now() / 1000),
          toleranceSeconds: env.WEBHOOK_TOLERANCE_SECONDS,
        });

        if (!verification.valid) {
          app.log.warn(
            { provider, reason: verification.reason },
            'webhook signature verification failed',
          );
          reply.status(401);
          return {
            received: false as const,
            error: verification.reason,
            message:
              verification.reason === 'malformed_header'
                ? verification.detail
                : 'signature does not match the raw request body',
          };
        }

        // STEP 2 — the bytes are authentic; now they can be parsed.
        let payload: z.infer<typeof WebhookPayload>;
        try {
          payload = WebhookPayload.parse(JSON.parse(rawBody.toString('utf8')));
        } catch {
          reply.status(400);
          return {
            received: false as const,
            error: 'malformed_payload',
            message: 'authentic request, but the body is not a valid event',
          };
        }

        const event: InboundEvent = {
          provider,
          idempotencyKey: payload.id,
          objectId: payload.objectId,
          eventType: payload.type,
          payloadHash: verification.payloadHash,
          payload: JSON.parse(rawBody.toString('utf8')),
          signatureValid: true,
          signedAt: new Date(verification.timestamp * 1000),
          withinWindow: verification.withinWindow,
        };

        /**
         * An authentic but stale payload is stored and rejected. Stored, because
         * the Settlements page should show that it arrived; rejected, because
         * accepting it would make a captured request replayable forever.
         */
        if (!verification.withinWindow) {
          await timed(request, () => ingest(app.pool, { ...event, signatureValid: true }));
          app.log.warn(
            { provider, event_id: payload.id, age_seconds: verification.ageSeconds },
            'webhook outside replay window',
          );
          reply.status(400);
          return {
            received: false as const,
            error: 'stale_timestamp',
            message: `signed ${String(verification.ageSeconds)}s from now, outside the ${String(env.WEBHOOK_TOLERANCE_SECONDS)}s window`,
          };
        }

        // STEP 3 — the unique index decides, not a prior SELECT.
        const outcome = await timed(request, () => ingest(app.pool, event));

        if (outcome.status === 'payload_conflict') {
          /**
           * Same event id, different bytes. A provider bug or a modified replay.
           * Logged at error level and never silently accepted — and only
           * detectable because the payload hash is stored.
           */
          app.log.error(
            {
              provider,
              event_id: payload.id,
              stored_hash: outcome.storedHash,
              incoming_hash: outcome.incomingHash,
            },
            'webhook payload conflict: same key, different payload',
          );
          reply.status(409);
          return {
            received: false as const,
            error: 'payload_conflict',
            message: 'this event id was already delivered with a different payload',
          };
        }

        if (outcome.status === 'in_flight') {
          /**
           * **409, not 200.** The first delivery is still working and may yet
           * fail. Answering 200 here tells the provider to stop retrying, and if
           * the work then fails the event is lost permanently while their
           * dashboard shows it delivered.
           */
          reply.status(409);
          return {
            received: false as const,
            error: 'in_progress',
            message: 'this event is already being processed; retry shortly',
          };
        }

        if (outcome.status === 'duplicate') {
          reply.status(200);
          return {
            received: true as const,
            eventId: payload.id,
            state: outcome.state as 'processed' | 'failed' | 'ignored',
            duplicate: true,
            deliveryCount: outcome.deliveryCount,
            transactionId: null,
          };
        }

        // STEP 4 — the same object under a different event id.
        const objectCheck = await timed(request, () =>
          alreadySettledForObject(app.pool, {
            provider,
            objectId: payload.objectId,
            eventType: payload.type,
            excludeId: outcome.id,
          }),
        );

        if (objectCheck.duplicate) {
          app.log.warn(
            { provider, event_id: payload.id, existing_key: objectCheck.existingKey },
            'same object and event type already settled under a different event id',
          );
          await settle(app.pool, outcome.id, { state: 'ignored' });
          reply.status(200);
          return {
            received: true as const,
            eventId: payload.id,
            state: 'ignored' as const,
            duplicate: true,
            deliveryCount: 1,
            transactionId: null,
          };
        }

        // STEP 5 — only one concurrent delivery proceeds.
        if (!(await beginProcessing(app.pool, outcome.id))) {
          reply.status(409);
          return {
            received: false as const,
            error: 'in_progress',
            message: 'another delivery claimed this event; retry shortly',
          };
        }

        // STEP 6 — the work, with the event settled in the same transaction.
        try {
          if (payload.type !== 'funding.succeeded') {
            // An event type this system does not act on. Recorded as `ignored`
            // rather than dropped, so the Settlements page can show it arrived
            // and was a deliberate no-op.
            await settle(app.pool, outcome.id, { state: 'ignored' });
            return {
              received: true as const,
              eventId: payload.id,
              state: 'ignored' as const,
              duplicate: false,
              deliveryCount: 1,
              transactionId: null,
            };
          }

          if (payload.accountId === undefined || payload.amount === undefined) {
            await settle(app.pool, outcome.id, {
              state: 'failed',
              errorDetail: 'funding.succeeded requires accountId and amount',
            });
            reply.status(422);
            return {
              received: false as const,
              error: 'incomplete_event',
              message: 'funding.succeeded requires accountId and amount',
            };
          }

          const result = await timed(request, () =>
            fundAccount(app, {
              accountExternalId: payload.accountId!,
              amount: payload.amount!,
              eventRowId: outcome.id,
              mode: request.ctx.flags.concurrencyMode,
            }),
          );

          if (result.status === 'unknown_account') {
            await settle(app.pool, outcome.id, {
              state: 'failed',
              errorDetail: `no account ${payload.accountId}`,
            });
            reply.status(422);
            return {
              received: false as const,
              error: 'unknown_account',
              message: `no account ${payload.accountId}`,
            };
          }

          request.ctx.retryCount = result.attempts - 1;

          return {
            received: true as const,
            eventId: payload.id,
            state: 'processed' as const,
            duplicate: false,
            deliveryCount: 1,
            transactionId: result.transactionId.toString(),
          };
        } catch (err) {
          /**
           * The work failed. The event is marked `failed` rather than left in
           * `processing`, so a replay gets a definite answer instead of a 409
           * forever — a key stuck in `processing` can never be retried.
           */
          await settle(app.pool, outcome.id, {
            state: 'failed',
            errorDetail: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
          });
          throw err;
        }
      };

      try {
        const outcome = await deliver();

        webhookDeliveries.inc({
          provider,
          outcome: outcome.received ? outcome.state : outcome.error,
        });

        /**
         * The duplicate *rate* is this counter over `webhookDeliveries`, divided
         * at query time. Both the `duplicate` ack path (same event id) and the
         * `payload_conflict` / `in_progress` rejections are redeliveries, but
         * only the first is a benign one — so only it is counted here, and the
         * others stay visible under their own `outcome` label.
         */
        if (outcome.received && outcome.duplicate) {
          webhookDuplicates.inc({ provider });
        }

        return outcome;
      } catch (err) {
        // A throw reaches the error handler as a 500. Counted, because an
        // uncounted 500 makes every ratio built on this metric wrong by exactly
        // the amount that matters most.
        webhookDeliveries.inc({ provider, outcome: 'error' });
        throw err;
      }
    },
  });
};

/**
 * Credit a customer's cash account from the funding boundary.
 *
 * Two legs, one unit: `external_funding` is debited and the customer credited.
 * The external account goes negative by exactly the money that has entered the
 * system, which is what keeps `SUM(entries.amount) = 0` true globally rather
 * than only per customer — and is why it is absent from `requireNonNegative`.
 */
async function fundAccount(
  app: Parameters<FastifyPluginAsyncZod>[0],
  input: {
    accountExternalId: string;
    amount: string;
    eventRowId: bigint;
    mode: 'pessimistic' | 'serializable' | 'advisory';
  },
): Promise<
  { status: 'funded'; transactionId: bigint; attempts: number } | { status: 'unknown_account' }
> {
  const { rows } = await app.pool.query<{ customer: bigint | null; external: bigint | null }>(
    `SELECT c.id AS customer, e.id AS external
       FROM (SELECT 1) anchor
       LEFT JOIN accounts c ON c.external_id = $1 AND c.kind = 'customer_cash'
       LEFT JOIN accounts e ON e.external_id = 'external:funding'`,
    [input.accountExternalId],
  );

  const customer = rows[0]?.customer;
  const external = rows[0]?.external;
  if (customer === null || customer === undefined || external === null || external === undefined) {
    return { status: 'unknown_account' };
  }

  // `parseCash` from @daftar/money, not a hand-rolled split: it is the only
  // sanctioned parser, it is exact, and it rejects the inputs Number() accepts.
  const amountMinor = parseCash(input.amount);

  const result = await post(app.pool, {
    kind: 'funding',
    legs: [
      { accountId: external, amount: -amountMinor },
      { accountId: customer, amount: amountMinor },
    ],
    requireNonNegative: [],
    mode: input.mode,
    withinTransaction: async (client, transactionId) => {
      // Settled in the SAME transaction as the money movement. Separately would
      // leave a window where the funds landed and the event still said
      // `processing`, and a replay in that window would get a 409 for work that
      // definitely succeeded.
      await settle(client, input.eventRowId, { state: 'processed', transactionId });
    },
  });

  if (result.status !== 'posted') {
    throw new Error(`funding post returned ${result.status}`);
  }

  return { status: 'funded', transactionId: result.transactionId, attempts: result.attempts };
}
