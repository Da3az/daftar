/**
 * Fixed scales. Every amount in this system is an integer of minor units at one
 * of these scales, carried as a `bigint`.
 *
 * These are compile-time constants on purpose. A runtime-configurable scale means
 * an amount's meaning depends on config that is not stored next to it, and a
 * migration that changes it silently rescales history.
 */

/** Cash: 2 decimal places. 1 unit = 100 minor units. */
export const CASH_SCALE = 2 as const;

/**
 * Asset quantity: 8 decimal places, matching Bitcoin's satoshi granularity, which
 * is the finest of the assets quoted here. Using one scale for all assets keeps
 * the entries table homogeneous.
 */
export const QUANTITY_SCALE = 8 as const;

/**
 * Price: cash minor units per **one whole unit** of the asset. So a BTC price of
 * 95,432.17 is 9_543_217n — not per-satoshi, which would need 10 more digits of
 * scale to express a cent.
 */
export const PRICE_SCALE = 2 as const;

export type Scale = number;

/*
 * The branded aliases below are documentation that the compiler can check at call
 * sites where a function takes more than one bigint. They are intentionally plain
 * aliases rather than nominal brands: a nominal brand would need a cast at every
 * database boundary, and a cast that appears 200 times stops being read.
 */

/** An amount of cash, in minor units (cents). Always `bigint`. */
export type CashMinor = bigint;

/** An asset quantity, in units of 1e-8. Always `bigint`. */
export type Quantity = bigint;

/** A price, in cash minor units per one whole asset unit. Always `bigint`. */
export type PriceMinor = bigint;
