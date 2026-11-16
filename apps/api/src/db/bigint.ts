import pg from 'pg';

/**
 * Teach the `pg` driver to return PostgreSQL `int8` as a JavaScript `bigint`.
 *
 * ## Why this file exists
 *
 * By default `pg` returns `int8` (64-bit integer) as a **string**. That is the
 * right default for a general-purpose driver — an int8 ranges to 2^63-1, about a
 * thousand times larger than `Number.MAX_SAFE_INTEGER`, so returning a `number`
 * would silently lose precision. But it means every amount arrives as `"100"`,
 * and then:
 *
 * ```js
 * const balance = row.balance;      // "100"
 * const total = balance + amount;   // "100" + "50" === "10050"
 * ```
 *
 * A 100x error. Nothing throws. No type annotation catches it, because
 * `@types/pg` types a column as whatever you claimed it was. This is the
 * realistic money bug in a Node + PostgreSQL ledger — far more likely than a
 * float, because the float hazard is widely known and this one looks like it
 * already works.
 *
 * ## Ordering is load-bearing, twice
 *
 * **1. Relative to pool construction.** `setTypeParser` mutates a module-level
 * registry inside `pg-types`. It must run before any `Pool` or `Client` is
 * constructed. A module with a visible import-time side effect, imported at the
 * top of `db/pool.ts`, is the only ordering that import reshuffling cannot
 * break.
 *
 * **2. Relative to `defaults.parseInt8`.** This one is a genuine trap. Reading
 * `pg/lib/defaults.js`, `parseInt8` is not a plain boolean — it is a setter that
 * *reassigns the OID 20 and OID 1016 parsers* on every write:
 *
 * ```js
 * module.exports.__defineSetter__('parseInt8', function (val) {
 *   pgTypes.setTypeParser(20, 'text', val ? pgTypes.getTypeParser(23, 'text') : parseBigInteger)
 *   ...
 * ```
 *
 * So assigning it *after* installing a custom parser silently throws that parser
 * away. Measured on pg 8.23.1:
 *
 * ```text
 * setTypeParser(20, BigInt)      -> typeof value is "bigint"
 * defaults.parseInt8 = false     -> typeof value is "string"   <- parser gone
 * defaults.parseInt8 = true      -> typeof value is "number"   <- lossy
 * ```
 *
 * Therefore `parseInt8` is written **first**, to establish a known baseline, and
 * the custom parsers are installed after it. Doing it the intuitive way round is
 * a silent regression to lossy reads.
 *
 * ## What is deliberately NOT converted
 *
 * - `int4` / `int2` stay as `number`. They fit a double exactly and are not money.
 * - `numeric` stays a string. It has unbounded precision, so there is no lossless
 *   JavaScript primitive to map it to. This schema has no `numeric` column and a
 *   test keeps it that way.
 * - `COUNT(*)` returns int8, so counts arrive as `bigint` too. Correct, and
 *   occasionally surprising: `count === 1` is false where `count === 1n` holds.
 */

const { types, defaults } = pg;

/** OID 20. Read from `types.builtins` so an upstream change breaks the build. */
export const INT8_OID: number = types.builtins.INT8;

/**
 * OID 1016, `bigint[]`. `pg-types` has no `builtins` entry for array types.
 *
 * The `: number` annotation is load-bearing. `setTypeParser` takes `TypeId`, a
 * numeric *enum* of the OIDs with a `builtins` entry. Since TypeScript 5 made
 * enums union types, the literal type `1016` is not assignable to it — but the
 * widened `number` still is. Annotating the constant widens it and the call
 * typechecks with no cast, which is better than `as unknown as TypeId` papering
 * over a real type.
 */
export const INT8_ARRAY_OID: number = 1016;

let registered = false;

/**
 * Idempotent. Vitest imports this once per worker, and the flag gives tests
 * something to assert about the single-shot intent.
 */
export function registerBigIntTypeParser(): void {
  if (registered) return;

  // Step 1 — baseline. Must come first; see the ordering note above. This also
  // pins off the "give me counts as numbers" switch, which is lossy.
  defaults.parseInt8 = false;

  // Step 2 — scalars.
  types.setTypeParser(INT8_OID, (value: string): bigint => BigInt(value));

  // Step 3 — arrays. Rather than taking a direct dependency on `postgres-array`
  // (a transitive dep of pg-types, so not ours to rely on), wrap the parser
  // `parseInt8 = false` just restored: it already handles the array grammar,
  // quoting and NULL elements, and yields strings. Only the leaf conversion is
  // ours.
  const parseInt8ArrayAsStrings = types.getTypeParser(INT8_ARRAY_OID, 'text') as (
    value: string,
  ) => (string | null)[];

  types.setTypeParser(INT8_ARRAY_OID, (value: string): (bigint | null)[] =>
    parseInt8ArrayAsStrings(value).map((element) => (element === null ? null : BigInt(element))),
  );

  registered = true;
}

export const isBigIntTypeParserRegistered = (): boolean => registered;

// Side effect on import. See the ordering note above.
registerBigIntTypeParser();
