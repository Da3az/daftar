import { Dialog as D } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { scrim } from './overlay';

export const Sheet = D.Root;
export const SheetTrigger = D.Trigger;
export const SheetClose = D.Close;
export const SheetDescription = D.Description;

const sides = {
  right:
    'inset-y-0 right-0 w-[min(100vw,27rem)] border-l rounded-l-panel data-[state=open]:animate-slide-right',
  bottom:
    'inset-x-0 bottom-0 max-h-[88vh] border-t rounded-t-panel data-[state=open]:animate-slide-up',
} as const;

/** A panel that slides in from an edge: square where it is attached, rounded on its free corners. */
export function SheetContent({
  side = 'right',
  title,
  className,
  children,
  ...props
}: ComponentProps<typeof D.Content> & { side?: keyof typeof sides; title: ReactNode }) {
  return (
    <D.Portal>
      <D.Overlay className={scrim} />
      <D.Content
        className={cn(
          'fixed z-50 flex flex-col border-line-strong bg-surface text-ink shadow-overlay outline-none',
          sides[side],
          className,
        )}
        {...props}
      >
        <header className="flex flex-none items-center gap-5 border-b border-line px-7 py-5">
          <D.Title className="font-display text-lg font-semibold">{title}</D.Title>
          <D.Close className="ml-auto rounded-tag px-3 py-1 text-sm text-ink-2 underline underline-offset-4">
            Close
          </D.Close>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </D.Content>
    </D.Portal>
  );
}
