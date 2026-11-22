/**
 * The static half of the OpenAPI document. Paths and schemas are generated from
 * the Zod schemas on each route by `@fastify/type-provider-zod`, so there is one
 * source of truth for validation, TypeScript types and the published contract —
 * the single-source-of-truth property that is usually the argument for tRPC,
 * kept while staying REST.
 *
 * REST rather than tRPC here for two concrete reasons:
 *
 *  - the API has to be hammerable from Postman and k6 by someone who has never
 *    seen the repo, and
 *  - the webhook endpoint receives a body we do not control, with a signature
 *    over raw bytes, which is not an RPC call.
 */
import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger';

/*
 * Not `as const`: that makes every nested array `readonly`, and
 * @fastify/swagger's `tags` field is a mutable `TagObject[]`. Typing against the
 * plugin's own option type instead gets the field names checked, which is the
 * part worth having.
 *
 * `FastifyDynamicSwaggerOptions` rather than the exported `SwaggerOptions`:
 * the latter is a union with the static-spec variant, which has no `openapi`
 * key at all, so indexing the union does not resolve.
 */
export const OPENAPI_DOCUMENT: NonNullable<FastifyDynamicSwaggerOptions['openapi']> = {
  openapi: '3.1.0',
  info: {
    title: 'Daftar API',
    version: '0.1.0',
    description: [
      'A crypto brokerage backed by a double-entry ledger whose invariants are',
      'enforced by PostgreSQL rather than by application code.',
      '',
      '**Demo only. No real funds, no real custody, no real market access.**',
      '',
      '### Amounts',
      '',
      'Every monetary amount is an integer in **minor units** (cents for cash,',
      '1e-8 units for asset quantities) and crosses the wire as an exact decimal',
      'string — never a JSON number. JSON numbers are IEEE-754 doubles, so an',
      'amount above 2^53 minor units would be silently rounded in transit.',
      'Parse these with a decimal or bigint type, not `parseFloat`.',
      '',
      '### Prices',
      '',
      'Prices shown in the UI are live for display. The ledger is denominated in',
      'frozen integer minor units captured at order time, and the order path',
      'makes no external calls.',
    ].join('\n'),
    license: { name: 'MIT', identifier: 'MIT' },
  },
  servers: [{ url: '/', description: 'this server' }],
  tags: [
    { name: 'health', description: 'Liveness and readiness' },
    { name: 'accounts', description: 'Accounts and balances' },
    { name: 'orders', description: 'Order placement — the measured write path' },
    { name: 'ledger', description: 'Entries, transactions and statements' },
    { name: 'webhooks', description: 'Inbound provider events' },
    { name: 'chaos', description: 'Server-side concurrency bursts for the demo' },
    { name: 'admin', description: 'Operator routes behind ADMIN_TOKEN; 404 when it is unset' },
  ],
};
