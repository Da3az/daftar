import { z } from 'zod';
import { LEDGER_CONCURRENCY_MODES, env, type LedgerConcurrencyMode } from './env.ts';

/**
 * ## Flags are per request, never process-global
 *
 * Every deliberately naive path and every concurrency strategy is selected per
 * request, from headers, falling back to the environment defaults.
 *
 * Three reasons this matters rather than being a nicety:
 *
 * 1. The chaos panel has to run two profiles **side by side** — correct vs naive,
 *    pessimistic vs serializable — and compare them in one sitting. A global
 *    switch makes that two server restarts and two sets of conditions.
 * 2. A reviewer flipping a flag should see the difference on the next request,
 *    not after a restart. "Clone, flip, run, watch it break" is the deliverable.
 * 3. A module-level mutable flag read inside a transaction is itself a race: two
 *    concurrent requests would observe whichever value was written last. Which
 *    would be a delicious bug for this particular project to ship.
 */

export const FLAG_HEADERS = {
  concurrencyMode: 'x-daftar-concurrency-mode',
  naiveOverdraft: 'x-daftar-naive-overdraft',
  naiveLostUpdate: 'x-daftar-naive-lost-update',
} as const;

export interface RequestFlags {
  /** Which Phase 3 strategy the ledger write path uses. */
  concurrencyMode: LedgerConcurrencyMode;
  /** Phase 1: application-level funds check, then an atomic decrement. */
  naiveOverdraft: boolean;
  /** Phase 1: read balance, compute in JS, write an absolute value. */
  naiveLostUpdate: boolean;
}

export const defaultFlags = (): RequestFlags => ({
  concurrencyMode: env.LEDGER_CONCURRENCY_MODE,
  naiveOverdraft: env.DAFTAR_NAIVE_OVERDRAFT,
  naiveLostUpdate: env.DAFTAR_NAIVE_LOST_UPDATE,
});

const headerBool = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0']))
  .transform((v) => v === 'true' || v === '1');

const headerMode = z.enum(LEDGER_CONCURRENCY_MODES);

export class FlagHeaderError extends Error {
  readonly header: string;

  constructor(header: string, detail: string) {
    super(`invalid ${header}: ${detail}`);
    this.name = 'FlagHeaderError';
    this.header = header;
  }
}

type Headers = Record<string, string | string[] | undefined>;

/**
 * A repeated header arrives as an array. Taking the first element would let a
 * caller smuggle a second value past a proxy that only inspects one, so a
 * repeated flag header is rejected outright.
 */
function single(headers: Headers, name: string): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    throw new FlagHeaderError(name, 'header must not be repeated');
  }
  return raw;
}

/**
 * Resolve the flags in force for one request.
 *
 * When `ALLOW_FLAG_HEADERS` is off — the production default — headers are ignored
 * entirely rather than rejected. An unauthenticated header that selects a
 * deliberately-broken ledger path must not be reachable, and silently ignoring
 * it avoids handing a prober a signal that the feature exists.
 *
 * An invalid value **is** rejected when headers are allowed: silently falling
 * back to the default would make a typo in a benchmark script look like a
 * passing run of the strategy you thought you were testing.
 */
export function resolveFlags(headers: Headers): RequestFlags {
  const flags = defaultFlags();
  if (!env.ALLOW_FLAG_HEADERS) return flags;

  const mode = single(headers, FLAG_HEADERS.concurrencyMode);
  if (mode !== undefined) {
    const parsed = headerMode.safeParse(mode.trim().toLowerCase());
    if (!parsed.success) {
      throw new FlagHeaderError(
        FLAG_HEADERS.concurrencyMode,
        `expected one of ${LEDGER_CONCURRENCY_MODES.join(', ')}`,
      );
    }
    flags.concurrencyMode = parsed.data;
  }

  for (const [key, header] of [
    ['naiveOverdraft', FLAG_HEADERS.naiveOverdraft],
    ['naiveLostUpdate', FLAG_HEADERS.naiveLostUpdate],
  ] as const) {
    const raw = single(headers, header);
    if (raw === undefined) continue;

    const parsed = headerBool.safeParse(raw);
    if (!parsed.success) {
      throw new FlagHeaderError(header, 'expected true, false, 1 or 0');
    }
    flags[key] = parsed.data;
  }

  return flags;
}

/** Compact representation for the canonical log line and evidence files. */
export function describeFlags(flags: RequestFlags): string {
  const naive = [
    flags.naiveOverdraft ? 'naive_overdraft' : null,
    flags.naiveLostUpdate ? 'naive_lost_update' : null,
  ].filter((v): v is string => v !== null);

  return naive.length === 0 ? flags.concurrencyMode : `${flags.concurrencyMode}+${naive.join('+')}`;
}
