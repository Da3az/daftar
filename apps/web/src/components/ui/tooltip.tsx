import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const TooltipProvider = T.Provider;

/** A short explanation on hover or focus. `children` must be a single focusable element. */
export function Tip({
  text,
  children,
  side = 'top',
  className,
}: {
  text: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 max-w-140 rounded-tag bg-ink px-4 py-2 text-xs text-surface data-[state=delayed-open]:animate-rise',
            className,
          )}
        >
          {text}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
