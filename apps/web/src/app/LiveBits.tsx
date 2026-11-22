import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/api/context';
import { useLiveState } from '@/api/live';
import { keys, useNotifications } from '@/api/queries';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { showDateTime } from '@/lib/time';

/** Live / reconnecting / polling, said in words — never colour alone. */
export function LiveIndicator() {
  const state = useLiveState();
  const label =
    state === 'live'
      ? 'Live'
      : state === 'connecting'
        ? 'Connecting…'
        : state === 'reconnecting'
          ? 'Reconnecting — polling meanwhile'
          : 'Polling';
  return (
    <span
      role="status"
      className="flex items-center gap-3 whitespace-nowrap text-sm text-on-brand-muted"
      title={
        state === 'live'
          ? 'Updates are pushed to this page as they happen.'
          : 'This page asks the server for updates every second or two.'
      }
    >
      <span
        aria-hidden
        className={cn(
          'size-4 rounded-pill',
          state === 'live' ? 'bg-on-brand' : 'border border-dashed border-on-brand-muted',
        )}
      />
      {label}
    </span>
  );
}

export function NotificationBell() {
  const query = useNotifications();
  const api = useApi();
  const client = useQueryClient();
  const unread = query.data?.unread ?? 0;
  const list = query.data?.notifications ?? [];
  const markRead = useMutation({
    mutationFn: (upTo: string) => api.markNotificationsRead(upTo),
    onSettled: () => client.invalidateQueries({ queryKey: keys.notifications }),
  });

  return (
    <Popover
      onOpenChange={(open) => {
        const newest = list[0];
        if (!open && newest && unread > 0) markRead.mutate(newest.id);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative rounded-field border border-brand-line px-4 py-2 text-sm text-on-brand-muted"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          Notifications
          {unread > 0 && (
            <span className="num ml-2 rounded-pill bg-on-brand px-2 text-xs font-semibold text-header">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex max-h-96 w-80 flex-col gap-1 overflow-auto">
          {list.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing yet.</p>
          ) : (
            list.map((n) => (
              <div
                key={n.id}
                className={cn(
                  'border-t border-line py-2 first:border-t-0',
                  !n.read && 'font-semibold',
                )}
              >
                <p className="text-sm">{n.title}</p>
                {n.body && <p className="text-sm font-normal text-ink-2">{n.body}</p>}
                <p className="num text-xs font-normal text-ink-3">
                  {showDateTime(n.occurredAt)} UTC
                </p>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
