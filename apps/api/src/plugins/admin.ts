import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.ts';

/**
 * # The admin gate
 *
 * `/v1/admin/*` is reachable only with `Authorization: Bearer <ADMIN_TOKEN>`.
 * With `ADMIN_TOKEN` unset the routes answer **404**, not 401: a deployment
 * that has not opted into an admin surface should not advertise that it has
 * one. There is no development fallback token — a published one is no gate.
 *
 * The comparison hashes both sides first so `timingSafeEqual` sees equal
 * lengths and the token's length does not leak through an early return.
 */
const digest = (s: string) => createHash('sha256').update(s).digest();

export function isAdmin(request: FastifyRequest): boolean {
  if (env.ADMIN_TOKEN === undefined) return false;
  const header = request.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]!), digest(env.ADMIN_TOKEN));
}

/** For a route handler: returns true if it replied (and the handler should stop). */
export function rejectUnlessAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (env.ADMIN_TOKEN === undefined) {
    void reply
      .status(404)
      .send({ error: 'not_found', message: `${request.method} ${request.url}` });
    return true;
  }
  if (!isAdmin(request)) {
    void reply.status(401).send({ error: 'not_admin', message: 'admin token required' });
    return true;
  }
  return false;
}
