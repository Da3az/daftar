/* Fixed market rules. The server re-checks all of them; these exist so the ticket can say the rule before a refusal. */
export const SYMBOL = 'DFT';
export const QUOTE = 'USD';
export const MAX_ORDER_QTY_UNITS = 100_000n * 100_000_000n;
export const MAX_OPEN_ORDERS = 50;
export const MAX_DEPOSIT_CENTS = 1_000_000n;
export const MAX_MOVEMENT_CENTS = 100_000_000n;
export const DEPOSITS_PER_HOUR = 10;
export const DELIVERY_CHOICES = [1, 2, 5, 10] as const;
