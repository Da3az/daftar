#!/usr/bin/env node
/**
 * Sign and send a webhook payload.
 *
 * There is no real payment provider here, so this script is the provider. It
 * produces correctly signed requests, and deliberately incorrect ones, so every
 * branch of the webhook route is exercisable by hand and from the demo UI.
 *
 * Usage:
 *
 *   # a fresh funding event
 *   node scripts/sign-webhook.mjs fund --account seed-000000 --amount 500.00
 *
 *   # deliver the SAME event again (tests idempotency)
 *   node scripts/sign-webhook.mjs fund --account seed-000000 --amount 500.00 \
 *        --event-id evt_fixed_1 --repeat 3
 *
 *   # same event id, different body (tests the payload-hash conflict check)
 *   node scripts/sign-webhook.mjs conflict --event-id evt_fixed_1
 *
 *   # correctly signed but outside the replay window
 *   node scripts/sign-webhook.mjs stale --age 600
 *
 *   # signed with the wrong secret
 *   node scripts/sign-webhook.mjs forged
 *
 *   # print the request without sending it
 *   node scripts/sign-webhook.mjs fund --dry-run
 *
 * ## Why `--repeat` re-signs every delivery
 *
 * A real provider re-signs each retry with a **fresh timestamp**; it does not
 * resend captured bytes. So replaying one captured request would be testing the
 * *tolerance window*, not the idempotency check — the opposite of the intent,
 * and a mistake that makes a webhook suite look like it covers replay when it
 * covers clock skew.
 *
 * `--repeat` therefore sends the same event id and the same body, with a newly
 * computed signature and timestamp each time. Each delivery is independently
 * valid and fresh; only the idempotency key is shared. `stale` is the mode that
 * exercises the window, and it says so.
 */
import { createHmac, randomUUID } from 'node:crypto';

const SIGNATURE_HEADER = 'x-daftar-signature';

const args = process.argv.slice(2);
const mode = args[0] ?? 'fund';

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const BASE_URL = flag('base-url', process.env.BASE_URL ?? 'http://127.0.0.1:3000');
const PROVIDER = flag('provider', 'simbank');
const SECRET =
  flag('secret', process.env.WEBHOOK_SIGNING_SECRET) ?? 'whsec_development_only_not_a_real_secret';

/**
 * The signed payload is `"{timestamp}.{raw body}"` and the signature is
 * HMAC-SHA256 of it, hex-encoded. Reimplemented here rather than imported from
 * `apps/api/src/webhooks/signature.ts` **on purpose**: if both sides shared one
 * implementation, a bug in it would make the signature verify against itself and
 * the tests would pass while no real provider could ever sign a request this
 * server accepts. Two independent implementations agreeing is the actual claim.
 */
function sign(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function buildBody(mode) {
  const eventId = flag('event-id', `evt_${randomUUID()}`);
  const objectId = flag('object-id', `obj_${eventId.slice(-12)}`);

  switch (mode) {
    case 'fund':
    case 'stale':
    case 'forged':
      return {
        id: eventId,
        type: 'funding.succeeded',
        objectId,
        accountId: flag('account', 'seed-000000'),
        amount: flag('amount', '500.00'),
      };

    case 'conflict':
      // Same event id as a previous delivery, different amount. The payload hash
      // is what makes this detectable; without it the server would see a
      // familiar id and replay the old response.
      return {
        id: eventId,
        type: 'funding.succeeded',
        objectId,
        accountId: flag('account', 'seed-000000'),
        amount: flag('amount', '999999.00'),
      };

    case 'ignored':
      // A valid, authentic event this system does not act on.
      return { id: eventId, type: 'payout.succeeded', objectId };

    case 'malformed':
      // Authentic bytes, invalid event. Proves the route authenticates before
      // it validates, and reports the two differently.
      return { id: eventId, type: 'not.a.real.type', objectId };

    default:
      console.error(
        `unknown mode "${mode}". Expected: fund | stale | forged | conflict | ignored | malformed`,
      );
      process.exit(2);
  }
}

async function deliver({ rawBody, timestamp, secret, label }) {
  const signature = sign(secret, timestamp, rawBody);
  const header = `t=${timestamp},v1=${signature}`;

  if (has('dry-run')) {
    console.log(`--- ${label} (not sent) ---`);
    console.log(`POST ${BASE_URL}/v1/webhooks/${PROVIDER}`);
    console.log(`content-type: application/json`);
    console.log(`${SIGNATURE_HEADER}: ${header}`);
    console.log('');
    console.log(rawBody);
    console.log('');
    console.log('Equivalent curl:');
    console.log(
      `  curl -sS -X POST ${BASE_URL}/v1/webhooks/${PROVIDER} \\\n` +
        `    -H 'content-type: application/json' \\\n` +
        `    -H '${SIGNATURE_HEADER}: ${header}' \\\n` +
        `    --data-binary '${rawBody}'`,
    );
    return;
  }

  const res = await fetch(`${BASE_URL}/v1/webhooks/${PROVIDER}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: header },
    // `body` is the exact string that was signed. Passing an object here and
    // letting fetch serialise it would be the very bug this script's comments
    // are about.
    body: rawBody,
  });

  const text = await res.text();
  console.log(`${label}  ->  ${res.status}  ${text}`);
}

const body = buildBody(mode);

/**
 * `JSON.stringify` once, and sign and send *that exact string*. Serialising
 * twice — once to sign, once to send — would be correct today and a latent bug
 * the moment anything about the object changes between the two calls.
 */
const rawBody = JSON.stringify(body);

const nowSeconds = Math.floor(Date.now() / 1000);
const repeat = Number(flag('repeat', '1'));

if (!Number.isInteger(repeat) || repeat < 1) {
  console.error('--repeat needs a positive integer');
  process.exit(2);
}

switch (mode) {
  case 'stale': {
    // Correctly signed, with a timestamp outside the tolerance window. The
    // signature covers the timestamp, so this cannot be forged by editing the
    // header — it has to be genuinely signed at the old time.
    const age = Number(flag('age', '600'));
    await deliver({
      rawBody,
      timestamp: nowSeconds - age,
      secret: SECRET,
      label: `stale (signed ${age}s ago)`,
    });
    break;
  }

  case 'forged': {
    await deliver({
      rawBody,
      timestamp: nowSeconds,
      secret: 'whsec_this_is_the_wrong_secret_entirely',
      label: 'forged (wrong secret)',
    });
    break;
  }

  default: {
    for (let i = 1; i <= repeat; i += 1) {
      /**
       * A fresh timestamp and a fresh signature for every delivery. See the
       * header comment: this is what a real provider's retry looks like, and it
       * is what makes `--repeat` a test of idempotency rather than of the
       * tolerance window.
       */
      await deliver({
        rawBody,
        timestamp: Math.floor(Date.now() / 1000),
        secret: SECRET,
        label: `${mode} delivery ${i}/${repeat} (event ${body.id})`,
      });
    }
  }
}
