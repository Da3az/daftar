import { z } from 'zod';
import { CASH_SCALE, QUANTITY_SCALE, MoneyParseError, parseScaled } from '@daftar/money';

/**
 * Wire types for amounts.
 *
 * **Amounts cross the wire as exact decimal strings, never JSON numbers.** A
 * JSON number is an IEEE-754 double in every mainstream parser, so an amount
 * above 2^53 minor units is silently rounded in transit — by the client's
 * parser, after our validation has already passed. There is no server-side fix
 * for that; the only answer is not to put it in a JSON number.
 *
 * The schemas below are used for both request validation and the generated
 * OpenAPI document, so the published contract says `type: string` with a pattern
 * and cannot drift from what the server accepts.
 */

const DECIMAL_PATTERN = '^-?\\d+(\\.\\d+)?$';

function decimalAmount(options: {
  scale: number;
  allowNegative: boolean;
  description: string;
  example: string;
}): z.ZodType<bigint, string> {
  return z
    .string()
    .regex(new RegExp(DECIMAL_PATTERN), 'must be an exact decimal string')
    .describe(options.description)
    .meta({ example: options.example, pattern: DECIMAL_PATTERN })
    .transform((raw, context) => {
      let parsed: bigint;
      try {
        parsed = parseScaled(raw, options.scale);
      } catch (err) {
        context.addIssue({
          code: 'custom',
          message:
            err instanceof MoneyParseError
              ? err.message
              : `not an exact decimal with at most ${String(options.scale)} fractional digits`,
        });
        return z.NEVER;
      }

      if (!options.allowNegative && parsed <= 0n) {
        context.addIssue({ code: 'custom', message: 'must be greater than zero' });
        return z.NEVER;
      }

      return parsed;
    });
}

/** A positive cash amount, 2 decimal places, parsed to bigint minor units. */
export const PositiveCashAmount = decimalAmount({
  scale: CASH_SCALE,
  allowNegative: false,
  description:
    'Cash amount as an exact decimal string with at most 2 fractional digits. Never a JSON number.',
  example: '100.00',
});

/** A signed cash amount — balances can be negative under the naive paths. */
export const SignedCashAmount = decimalAmount({
  scale: CASH_SCALE,
  allowNegative: true,
  description: 'Signed cash amount as an exact decimal string with at most 2 fractional digits.',
  example: '-1234.56',
});

/** An asset quantity, 8 decimal places. */
export const PositiveQuantity = decimalAmount({
  scale: QUANTITY_SCALE,
  allowNegative: false,
  description:
    'Asset quantity as an exact decimal string with at most 8 fractional digits. Never a JSON number.',
  example: '0.50000000',
});

/**
 * An amount on the way **out**. Declared as a plain string so the OpenAPI
 * document advertises a string, and so a handler that forgets to format a bigint
 * fails response validation rather than relying on the serializer's bigint net.
 */
export const CashAmountOut = z
  .string()
  .regex(new RegExp(DECIMAL_PATTERN))
  .describe('Cash amount in minor units, rendered as an exact decimal string.')
  .meta({ example: '1000.00' });

/**
 * An account's client-facing identifier. Opaque, and the only id that leaves the
 * server: the internal bigint stays internal so a caller cannot enumerate
 * accounts or infer how many exist.
 */
export const ExternalId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be url-safe')
  .describe('Opaque client-facing account identifier.')
  .meta({ example: 'cash-0001' });
