import { Toaster as Sonner } from 'sonner';

/** Toasts: one sentence with a ruled left edge. No icons, no close button — they leave on their own or on swipe. */
export function Toaster() {
  return (
    <Sonner
      position="bottom-left"
      visibleToasts={4}
      duration={7000}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-[min(calc(100vw-2rem),24rem)] gap-5 rounded-field border border-line-strong border-l-[length:var(--border-accent)] border-l-info bg-surface p-6 text-sm text-ink shadow-overlay',
          title: 'font-semibold',
          description: 'text-ink-2',
          success: '!border-l-success',
          error: '!border-l-danger',
          warning: '!border-l-warning',
          icon: 'hidden',
        },
      }}
    />
  );
}
