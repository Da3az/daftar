import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';

/**
 * Keep the raw request bytes for signature verification.
 *
 * Fastify's built-in JSON parser consumes the stream and hands the route a
 * parsed object; the original bytes are gone. The webhook signature is computed
 * over those bytes, so verifying against a re-serialisation cannot work — see
 * `signature.ts` for the measured list of what a `JSON.parse`/`stringify` round
 * trip changes.
 *
 * So this plugin installs a content-type parser for `application/json` that
 * keeps the buffer on the request *and* parses it, giving routes both.
 *
 * ## Scoped, not global
 *
 * Registered inside the webhook route's own plugin scope. Fastify's
 * encapsulation means the parser applies only there, so every other route keeps
 * the default parser and does not retain a buffer it will never read. Retaining
 * raw bodies globally is a memory cost on every request and a liability in heap
 * dumps — a copy of every payload, including anything sensitive, sitting on a
 * live object.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The exact bytes received, before parsing. Only present on routes within
     * the scope that registered `rawBodyPlugin`.
     */
    rawBody?: Buffer;
  }
}

export const rawBodyPlugin = fp(
  // fastify-plugin's async form. Nothing here awaits; see the require-await
  // override for plugin files in eslint.config.js.
  async (app) => {
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (request: FastifyRequest, body: Buffer, done) => {
        request.rawBody = body;

        // An empty body is legal to receive and must not become a parse error:
        // the route needs to verify the signature over zero bytes and report a
        // signature failure, not a 400 that leaks whether the secret was right.
        if (body.length === 0) {
          done(null, {});
          return;
        }

        try {
          done(null, JSON.parse(body.toString('utf8')));
        } catch {
          /**
           * Parse failure is deliberately NOT fatal here. The signature is over
           * the raw bytes, so an unparseable body can still be authentic — and
           * the route must decide. Rejecting now would answer a malformed
           * request differently depending on whether it was signed, which is a
           * small oracle.
           *
           * The route sees `rawBody` and an empty object, verifies, and then
           * reports a malformed payload *after* authentication.
           */
          done(null, {});
        }
      },
    );
  },
  { name: 'raw-body' },
);
