import pg from 'pg';

/**
 * Keep PostgreSQL timestamps as exact strings instead of letting `pg` parse them
 * into JavaScript `Date` objects.
 *
 * ## Why
 *
 * PostgreSQL's `timestamptz` stores **microsecond** resolution. A JavaScript
 * `Date` holds milliseconds. So the driver's default parser silently truncates
 * three digits. Measured on pg 8.23.1:
 *
 * ```text
 * server sends : "2026-01-02 03:04:05.123456+00"
 * Date parsed  :  2026-01-02T03:04:05.123Z        <- .456 µs gone
 * ```
 *
 * For most applications that is irrelevant. For this one it is a correctness
 * problem, for a specific reason: Phase 6's account statement orders by
 * `(created_at, id)` and computes a running balance over that order. Truncating
 * to milliseconds **manufactures ties** — two entries 400 µs apart become
 * equal — and a tie in a ledger's ordering is a non-deterministic running
 * balance. The `id` tiebreaker handles genuine ties; it should not have to
 * handle ties the driver invented.
 *
 * It also matters on the way out: a client that receives a truncated timestamp,
 * sorts by it, and renders a running balance gets a different answer from the
 * server's. The API therefore publishes the full-precision value.
 *
 * ## Why not `numeric`-style "just keep it as text"
 *
 * It *is* kept as text — but normalised to RFC 3339, because PostgreSQL's ISO
 * output uses a space separator and a bare-hours offset (`+00`), neither of
 * which `Date.parse`, `Temporal`, or most other languages' parsers accept
 * reliably. Normalising is a lossless textual rewrite; parsing is not.
 *
 * Consumers that want a `Date` can construct one and accept the truncation
 * knowingly. The point is that the loss is theirs to choose, not ours to impose.
 */

const { types } = pg;

export const TIMESTAMPTZ_OID: number = types.builtins.TIMESTAMPTZ; // 1184
export const TIMESTAMP_OID: number = types.builtins.TIMESTAMP; // 1114
export const DATE_OID: number = types.builtins.DATE; // 1082

/**
 * Rewrite PostgreSQL's ISO output into RFC 3339, without touching the digits.
 *
 *   `2026-01-02 03:04:05.123456+00`     -> `2026-01-02T03:04:05.123456Z`
 *   `2026-01-02 03:04:05.123456+05:30`  -> `2026-01-02T03:04:05.123456+05:30`
 *   `2026-01-02 03:04:05`               -> `2026-01-02T03:04:05`  (timestamp, no zone)
 *
 * The database runs with `timezone=UTC` (pinned in compose.yaml and in the
 * Terraform-managed config), so in practice the offset is always `+00`. The
 * other branches exist so that a misconfigured server produces a correct string
 * rather than a subtly wrong one.
 */
export function normaliseTimestamp(raw: string): string {
  // PostgreSQL emits these verbatim for out-of-range values; they are not
  // timestamps and must not be rewritten.
  if (raw === 'infinity' || raw === '-infinity') return raw;

  let out = raw.replace(' ', 'T');

  // Bare-hour offset -> hh:mm. `+00` is not valid RFC 3339; `+00:00` is.
  out = out.replace(/([+-])(\d{2})$/, '$1$2:00');

  // `+00:00` -> `Z`, the conventional spelling for UTC.
  out = out.replace(/([+-])00:00$/, 'Z');

  return out;
}

let registered = false;

export function registerTimestampTypeParsers(): void {
  if (registered) return;

  types.setTypeParser(TIMESTAMPTZ_OID, normaliseTimestamp);

  /**
   * `timestamp` (no time zone) is not used by this schema — every temporal
   * column is `timestamptz`, because a bare timestamp is ambiguous the moment
   * two processes in different zones write to it. The parser is registered
   * anyway so that if someone adds one, it behaves consistently instead of
   * becoming the one `Date` in the codebase.
   */
  types.setTypeParser(TIMESTAMP_OID, normaliseTimestamp);

  /** `date` as `YYYY-MM-DD`, not a Date pinned to midnight in some zone. */
  types.setTypeParser(DATE_OID, (value: string): string => value);

  registered = true;
}

export const areTimestampTypeParsersRegistered = (): boolean => registered;

// Side effect on import, for the same reason as db/bigint.ts: a pool captures
// the parsers in force when its connections are created.
registerTimestampTypeParsers();
