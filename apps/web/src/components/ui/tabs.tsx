import { Tabs as T } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const Tabs = T.Root;
export const TabsContent = T.Content;

/** Text tabs with a brand underline. No boxes. */
export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return <T.List className={cn('flex gap-9 border-b border-line', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        '-mb-px whitespace-nowrap border-b-3 border-transparent pb-3 pt-1 text-md font-medium text-ink-3 data-[state=active]:border-brand data-[state=active]:text-ink dark:data-[state=active]:border-state-open',
        className,
      )}
      {...props}
    />
  );
}
