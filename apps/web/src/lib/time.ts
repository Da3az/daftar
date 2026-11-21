/* All times are UTC and are labelled so wherever they appear. Formatting is total: bad input gives an em dash. */
const DASH = '—';
const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function parse(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "13:14:30" */
export function showTime(value: unknown): string {
  const d = parse(value);
  return d ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : DASH;
}

/** "14 Mar 13:14:30" */
export function showDateTime(value: unknown): string {
  const d = parse(value);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${showTime(value)}` : DASH;
}

/** "2026-03-14 13:14:30.512 UTC" — for receipts and tooltips. */
export function showExact(value: unknown): string {
  const d = parse(value);
  if (!d) return DASH;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${showTime(value)}.${pad(d.getUTCMilliseconds(), 3)} UTC`;
}

/** Delivery lag between two timestamps: "+0.8 s", "+12 s". */
export function showLag(from: unknown, to: unknown): string {
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return DASH;
  const ms = Math.max(0, b.getTime() - a.getTime());
  return ms < 10_000 ? `+${(ms / 1000).toFixed(1)} s` : `+${Math.round(ms / 1000)} s`;
}

/** "mm:ss" until the current candle bucket closes. */
export function countdownTo(bucketSeconds: number, nowMs: number): string {
  const left = bucketSeconds - (Math.floor(nowMs / 1000) % bucketSeconds);
  return `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
}
