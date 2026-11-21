import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { postWithin } from '../ledger/post.ts';
import type { ParticipantKind } from './engine.ts';

/**
 * # Participants: guests and bots
 *
 * A participant is a cash account, one position account per market, and a row
 * saying which of the two kinds it is. The kind is the only thing that differs
 * between a visitor and a market maker: a `guest` cannot go negative, a `bot`
 * can.
 */

/** 10,000.00, in cash minor units. What a guest is handed on entry. */
export const GUEST_STARTING_CASH = 1_000_000n;

/**
 * The boundary account guest money enters from.
 *
 * A guest's opening balance is a ledger transaction like any other — this
 * account is debited and the guest credited — rather than a number written into
 * `accounts.balance`. Its balance is therefore exactly minus the total ever
 * handed out, and `SUM(entries.amount) = 0` stays true globally rather than
 * only per customer.
 *
 * Separate from the legacy `external:funding`, so play money issued to guests
 * and provider-funded deposits do not share a figure.
 */
export const GUEST_FAUCET_EXTERNAL_ID = 'external:guest-faucet';

export interface Participant {
  externalId: string;
  kind: ParticipantKind;
  displayName: string;
  createdAt: string;
}

const BOT_NAMES = [
  'Atlas',
  'Basil',
  'Cedar',
  'Dune',
  'Ember',
  'Fjord',
  'Garnet',
  'Harbor',
  'Indigo',
  'Juniper',
  'Kestrel',
  'Lumen',
  'Marlow',
  'Nimbus',
  'Orchid',
  'Pavo',
] as const;

export const botExternalId = (index: number): string => `bot-${String(index + 1).padStart(2, '0')}`;

const botDisplayName = (index: number): string =>
  BOT_NAMES[index] ?? `Bot ${String(index + 1).padStart(2, '0')}`;

async function marketSymbols(client: pg.PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ symbol: string }>(
    'SELECT symbol FROM markets ORDER BY symbol',
  );
  return rows.map((r) => r.symbol);
}

/**
 * Create the accounts and the participant row, in the caller's transaction.
 *
 * `ON CONFLICT DO NOTHING` throughout, so it is safe to call for a bot that
 * already exists — which is every boot after the first.
 */
async function insertParticipant(
  client: pg.PoolClient,
  participant: { externalId: string; kind: ParticipantKind; displayName: string },
  symbols: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol)
     VALUES ($1, 'customer_cash', NULL)
     ON CONFLICT (external_id) DO NOTHING`,
    [participant.externalId],
  );

  await client.query(
    `INSERT INTO accounts (external_id, kind, asset_symbol)
     SELECT $1 || ':' || s, 'customer_asset', s FROM unnest($2::text[]) AS s
     ON CONFLICT (external_id) DO NOTHING`,
    [participant.externalId, symbols],
  );

  await client.query(
    `INSERT INTO participants (external_id, kind, display_name, cash_account_id)
     SELECT $1, $2::participant_kind, $3, a.id FROM accounts a WHERE a.external_id = $1
     ON CONFLICT (external_id) DO NOTHING`,
    [participant.externalId, participant.kind, participant.displayName],
  );
}

/**
 * Create a guest and fund it, atomically.
 *
 * One transaction: a guest that exists has its opening balance, and an opening
 * balance has a ledger transaction behind it. A crash between "created" and
 * "funded" would otherwise leave a session cookie pointing at an account that
 * can never trade.
 *
 * The id carries 8 random bytes. It is the session's subject and is never shown
 * to another participant, but the legacy read endpoints will return any account
 * whose `external_id` a caller can name — so it has to be unguessable rather
 * than sequential.
 */
export async function createGuest(pool: pg.Pool): Promise<Participant> {
  const suffix = randomBytes(8).toString('hex');
  const externalId = `guest-${suffix}`;
  const displayName = `Guest ${suffix.slice(-4).toUpperCase()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const symbols = await marketSymbols(client);

    await client.query(
      `INSERT INTO accounts (external_id, kind, asset_symbol)
       VALUES ($1, 'external_funding', NULL)
       ON CONFLICT (external_id) DO NOTHING`,
      [GUEST_FAUCET_EXTERNAL_ID],
    );

    await insertParticipant(client, { externalId, kind: 'guest', displayName }, symbols);

    const { rows } = await client.query<{ external_id: string; id: bigint }>(
      'SELECT external_id, id FROM accounts WHERE external_id IN ($1, $2)',
      [GUEST_FAUCET_EXTERNAL_ID, externalId],
    );
    const faucet = rows.find((r) => r.external_id === GUEST_FAUCET_EXTERNAL_ID)!.id;
    const cash = rows.find((r) => r.external_id === externalId)!.id;

    const funded = await postWithin(client, {
      kind: 'funding',
      legs: [
        { accountId: faucet, amount: -GUEST_STARTING_CASH },
        { accountId: cash, amount: GUEST_STARTING_CASH },
      ],
      mode: 'advisory',
    });

    if (funded.status !== 'posted') {
      throw new Error(`guest funding was refused: ${funded.status}`);
    }

    const { rows: created } = await client.query<{ created_at: string }>(
      'SELECT created_at FROM participants WHERE external_id = $1',
      [externalId],
    );

    await client.query('COMMIT');

    return { externalId, kind: 'guest', displayName, createdAt: created[0]!.created_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Make sure bots `0 … count-1` exist. Returns their external ids, in order. */
export async function ensureBots(pool: pg.Pool, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => botExternalId(index));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const symbols = await marketSymbols(client);

    for (const [index, externalId] of ids.entries()) {
      await insertParticipant(
        client,
        { externalId, kind: 'bot', displayName: botDisplayName(index) },
        symbols,
      );
    }

    await client.query('COMMIT');
    return ids;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function findParticipant(
  pool: pg.Pool,
  externalId: string,
): Promise<(Participant & { id: bigint }) | null> {
  const { rows } = await pool.query<{
    id: bigint;
    external_id: string;
    kind: ParticipantKind;
    display_name: string;
    created_at: string;
  }>(
    `SELECT id, external_id, kind, display_name, created_at
       FROM participants WHERE external_id = $1`,
    [externalId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    externalId: row.external_id,
    kind: row.kind,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}
