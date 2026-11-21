import { Switch as S } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/** On/off for a setting. The thumb is square-ish so it does not read as a stock toggle. */
export function Switch({ className, ...props }: ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        'inline-flex h-10 w-18 flex-none items-center rounded-tag border border-field bg-well p-px data-[state=checked]:border-brand data-[state=checked]:bg-brand',
        className,
      )}
      {...props}
    >
      <S.Thumb className="block size-8 rounded-bar bg-ink-3 transition-transform duration-(--duration-move) data-[state=checked]:translate-x-8 data-[state=checked]:bg-on-brand" />
    </S.Root>
  );
}
