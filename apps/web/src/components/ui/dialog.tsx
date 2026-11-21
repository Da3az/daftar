import { AlertDialog as A, Dialog as D } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { scrim } from './overlay';

const panel =
  'fixed left-1/2 top-[18vh] z-50 w-[min(calc(100vw-1rem),var(--dialog-width,26rem))] -translate-x-1/2 rounded-panel border border-line-strong bg-surface text-ink shadow-overlay outline-none data-[state=open]:animate-rise';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export const DialogTitle = D.Title;
export const DialogDescription = D.Description;

export function DialogContent({ className, children, ...props }: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Overlay className={scrim} />
      <D.Content className={cn(panel, className)} {...props}>
        {children}
      </D.Content>
    </D.Portal>
  );
}

/* AlertDialog: destructive confirmation only (leave account, cancel all). */
export const AlertDialog = A.Root;
export const AlertDialogTrigger = A.Trigger;
export const AlertDialogTitle = A.Title;
export const AlertDialogDescription = A.Description;
export const AlertDialogCancel = A.Cancel;
export const AlertDialogAction = A.Action;

export function AlertDialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof A.Content>) {
  return (
    <A.Portal>
      <A.Overlay className={scrim} />
      <A.Content className={cn(panel, 'p-10', className)} {...props}>
        {children}
      </A.Content>
    </A.Portal>
  );
}
