import { LinkButton } from '@/components/bits';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const ROWS = [
  [
    'Asking',
    'Sellers and the lowest price each will accept. Buy from them straight away, or bid less and wait.',
  ],
  [
    'Bidding',
    'Buyers and the highest price each will pay. Sell to them straight away, or ask for more and wait.',
  ],
  [
    'Quantity',
    'How many coins are offered at that price, from however many orders the last column counts.',
  ],
  [
    'Running total',
    'Coins you would get through if you traded every row from the middle out to this one.',
  ],
  [
    'Middle and gap',
    'Halfway between the best bid and best ask, and how far apart they are. A small gap means buyers and sellers nearly agree.',
  ],
] as const;

/** A one-screen explanation of the order book for someone who has never seen one. */
export function BookBasics() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <LinkButton>What am I looking at?</LinkButton>
      </PopoverTrigger>
      <PopoverContent className="w-200">
        <h3 className="font-display text-lg font-semibold">The order book</h3>
        <p className="mt-2 text-ink-2">
          Every order waiting to trade, best prices in the middle. A trade happens when someone
          accepts a price that is already here — that price becomes the last price.
        </p>
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3">
          {ROWS.map(([term, text]) => (
            <div key={term} className="contents">
              <dt className="whitespace-nowrap font-semibold">{term}</dt>
              <dd className="text-ink-2">{text}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 text-ink-2">
          Click any price to put it in the order form. Point at a row to see what trading down to it
          would cost.
        </p>
      </PopoverContent>
    </Popover>
  );
}
