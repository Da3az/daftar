import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { showTime } from '@/lib/time';

/** A bordered surface with a title row. When its data is stale the title row is hatched and says since when. */
export function Panel({
  title,
  actions,
  aside,
  staleSince,
  children,
  className,
  bodyClassName,
  id,
  plain,
}: {
  title: ReactNode;
  /** Sits right after the title. */
  aside?: ReactNode;
  /** Pushed to the right edge. */
  actions?: ReactNode;
  /** ms timestamp of the last good data, when a refresh has failed. */
  staleSince?: number | null;
  children: ReactNode;
  className?: string | undefined;
  bodyClassName?: string | undefined;
  id?: string | undefined;
  /** No frame and no title row: for when a sheet or dialog already provides them. */
  plain?: boolean | undefined;
}) {
  if (plain)
    return (
      <section id={id} className={cn('flex min-h-0 min-w-0 flex-col pt-5', className)}>
        {children}
      </section>
    );
  return (
    <section
      id={id}
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-panel border border-line bg-surface',
        className,
      )}
    >
      <header
        className={cn(
          'flex flex-none flex-wrap items-center gap-x-5 gap-y-2 px-7 pb-4 pt-5',
          staleSince && 'stale-hatch',
        )}
      >
        <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
        {aside}
        {staleSince ? (
          <span
            role="status"
            title="A refresh failed. The last good data is shown and the page keeps retrying."
            className="whitespace-nowrap rounded-tag bg-warning-wash px-3 text-xs font-medium text-warning"
          >
            Out of date · <span className="num">{showTime(staleSince)}</span> UTC
          </span>
        ) : null}
        {actions && <div className="ml-auto flex items-center gap-5">{actions}</div>}
      </header>
      <div className={cn('flex min-h-0 flex-1 flex-col', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Column heading cell and body cell classes shared by every table. */
export const th =
  'whitespace-nowrap border-b border-line px-5 py-2 text-left text-xs font-medium text-ink-3';
export const td = 'whitespace-nowrap px-5 text-sm';
