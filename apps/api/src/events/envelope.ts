import { z } from 'zod';

/**
 * # The event envelope
 *
 * What the relay puts on the wire for every outbox row. Ids are **decimal
 * strings**, never JSON numbers: an outbox id or an account id is an int8, and
 * `JSON.parse` silently rounds anything above 2^53.
 *
 * `eventId` is the outbox row's id. It is the idempotency key every consumer
 * dedupes on, and it is stable across a replay, a backfill and a relay retry —
 * which is the whole reason the relay publishes outbox rows rather than
 * minting new ids.
 *
 * `schemaVersion` is checked by consumers. A message from a future version is
 * a poison message for an old consumer, not something to guess at.
 */

export const ENVELOPE_SCHEMA_VERSION = 1;

const decimalId = z.string().regex(/^[0-9]{1,19}$/, 'an int8 as a decimal string');

export const envelopeSchema = z.object({
  schemaVersion: z.literal(ENVELOPE_SCHEMA_VERSION),
  eventId: decimalId,
  type: z.string().min(1).max(100),
  accountId: decimalId,
  transactionId: decimalId,
  /** The outbox row's `created_at`: when the money moved, not when it was relayed. */
  occurredAt: z.string().min(1),
  payload: z.unknown(),
});

export type EnvelopeWire = z.infer<typeof envelopeSchema>;

/** The envelope with its ids as bigints, as the application uses them. */
export interface Envelope {
  eventId: bigint;
  type: string;
  accountId: bigint;
  transactionId: bigint;
  occurredAt: string;
  payload: unknown;
}

export function encodeEnvelope(event: Envelope): string {
  const wire: EnvelopeWire = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    eventId: event.eventId.toString(),
    type: event.type,
    accountId: event.accountId.toString(),
    transactionId: event.transactionId.toString(),
    occurredAt: event.occurredAt,
    payload: event.payload ?? null,
  };
  return JSON.stringify(wire);
}

export class EnvelopeDecodeError extends Error {
  override name = 'EnvelopeDecodeError';
}

/** Parse and validate. Throws `EnvelopeDecodeError` — a poison message, never retried. */
export function decodeEnvelope(raw: string | undefined): Envelope {
  if (raw === undefined) throw new EnvelopeDecodeError('message has no value');

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new EnvelopeDecodeError('message value is not JSON');
  }

  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new EnvelopeDecodeError(`invalid envelope: ${z.prettifyError(parsed.error)}`);
  }

  const w = parsed.data;
  return {
    eventId: BigInt(w.eventId),
    type: w.type,
    accountId: BigInt(w.accountId),
    transactionId: BigInt(w.transactionId),
    occurredAt: w.occurredAt,
    payload: w.payload,
  };
}
