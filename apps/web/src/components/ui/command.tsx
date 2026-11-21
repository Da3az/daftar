import { Command as C } from 'cmdk';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const Command = C;
export const CommandEmpty = C.Empty;

export function CommandInput(props: ComponentProps<typeof C.Input>) {
  return (
    <C.Input
      className="w-full border-b border-line bg-transparent px-7 py-6 text-lg outline-none placeholder:text-ink-3"
      {...props}
    />
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof C.List>) {
  return <C.List className={cn('max-h-[50vh] overflow-y-auto p-3', className)} {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof C.Group>) {
  return (
    <C.Group
      className={cn(
        '[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-4 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3',
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof C.Item>) {
  return (
    <C.Item
      className={cn(
        'flex cursor-default items-center justify-between gap-8 rounded-tag px-4 py-4 text-md data-[selected=true]:bg-well data-[disabled=true]:text-ink-3',
        className,
      )}
      {...props}
    />
  );
}
