import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMe } from '@/api/queries';
import { Kbd } from '@/components/bits';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useTicket } from '@/features/trade/ticketStore';
import { setPrefs, usePrefs } from '@/lib/prefs';
import { emit, listen, SHORTCUTS } from './actions';

interface Action {
  group: string;
  label: string;
  hint?: string | undefined;
  run: () => void;
}

/** Actions, not search: with one market there is nothing to look up, but plenty to do. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const navigate = useNavigate();
  const ticket = useTicket();
  const prefs = usePrefs();
  const me = useMe().data;
  useEffect(() => listen('daftar:palette', () => setOpen((value) => !value)), []);
  useEffect(() => listen('daftar:keys', () => setKeysOpen(true)), []);

  const go = (to: string) => () => void navigate(to);
  const trade = (run: () => void) => () => {
    void navigate('/');
    run();
  };
  const actions: Action[] = [
    { group: 'Go to', label: 'Trade', hint: 'G T', run: go('/') },
    { group: 'Go to', label: 'Portfolio', hint: 'G P', run: go('/portfolio') },
    { group: 'Go to', label: 'History', hint: 'G H', run: go('/history') },
    { group: 'Order', label: 'Buy side', hint: 'B', run: trade(() => ticket.setSide('buy')) },
    { group: 'Order', label: 'Sell side', hint: 'S', run: trade(() => ticket.setSide('sell')) },
    { group: 'Order', label: 'Limit order', hint: 'L', run: trade(() => ticket.setType('limit')) },
    {
      group: 'Order',
      label: 'Market order',
      hint: 'M',
      run: trade(() => ticket.setType('market')),
    },
    {
      group: 'Chart',
      label: '1 minute candles',
      hint: '1',
      run: trade(() => emit('daftar:interval', '1m')),
    },
    {
      group: 'Chart',
      label: '5 minute candles',
      hint: '2',
      run: trade(() => emit('daftar:interval', '5m')),
    },
    {
      group: 'Chart',
      label: '1 hour candles',
      hint: '3',
      run: trade(() => emit('daftar:interval', '1h')),
    },
    ...(me
      ? [
          { group: 'Cash', label: 'Deposit cash', run: go('/portfolio?cash=deposit') },
          { group: 'Cash', label: 'Withdraw cash', run: go('/portfolio?cash=withdraw') },
          { group: 'Cash', label: 'Send cash to a handle', run: go('/portfolio?cash=send') },
          {
            group: 'Cash',
            label: 'Copy my handle',
            hint: me.handle,
            run: () => void navigator.clipboard.writeText(me.handle).catch(() => undefined),
          },
        ]
      : []),
    {
      group: 'Display',
      label: 'Light theme',
      hint: prefs.theme === 'light' ? 'on' : undefined,
      run: () => setPrefs({ theme: 'light' }),
    },
    {
      group: 'Display',
      label: 'Dark theme',
      hint: prefs.theme === 'dark' ? 'on' : undefined,
      run: () => setPrefs({ theme: 'dark' }),
    },
    {
      group: 'Display',
      label: 'Theme follows this device',
      hint: prefs.theme === 'system' ? 'on' : undefined,
      run: () => setPrefs({ theme: 'system' }),
    },
    {
      group: 'Display',
      label: 'Colours: green buys, red sells',
      hint: prefs.scheme === 'green-up' ? 'on' : undefined,
      run: () => setPrefs({ scheme: 'green-up' }),
    },
    {
      group: 'Display',
      label: 'Colours: red buys, green sells',
      hint: prefs.scheme === 'red-up' ? 'on' : undefined,
      run: () => setPrefs({ scheme: 'red-up' }),
    },
    {
      group: 'Display',
      label: 'Colours: blue buys, orange sells (colour-blind safe)',
      hint: prefs.scheme === 'blue-orange' ? 'on' : undefined,
      run: () => setPrefs({ scheme: 'blue-orange' }),
    },
    {
      group: 'Display',
      label: prefs.flash ? 'Stop flashing changed numbers' : 'Flash changed numbers',
      run: () => setPrefs({ flash: !prefs.flash }),
    },
    {
      group: 'Display',
      label: prefs.shortcuts ? 'Turn off single-key shortcuts' : 'Turn on single-key shortcuts',
      run: () => setPrefs({ shortcuts: !prefs.shortcuts }),
    },
    { group: 'Help', label: 'Keyboard shortcuts', hint: '?', run: () => setKeysOpen(true) },
  ];
  const groups = [...new Set(actions.map((action) => action.group))];

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          style={{ ['--dialog-width' as string]: '34rem' }}
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">Search actions</DialogTitle>
          <Command loop>
            <CommandInput placeholder="What do you want to do?" autoFocus />
            <CommandList>
              <CommandEmpty className="px-4 py-6 text-sm text-ink-3">
                No action matches that.
              </CommandEmpty>
              {groups.map((group) => (
                <CommandGroup key={group} heading={group}>
                  {actions
                    .filter((action) => action.group === group)
                    .map((action) => (
                      <CommandItem
                        key={action.label}
                        value={`${group} ${action.label}`}
                        onSelect={() => {
                          setOpen(false);
                          action.run();
                        }}
                      >
                        <span>{action.label}</span>
                        {action.hint && (
                          <span className="num text-xs text-ink-3">{action.hint}</span>
                        )}
                      </CommandItem>
                    ))}
                </CommandGroup>
              ))}
            </CommandList>
            <footer className="flex gap-8 border-t border-line px-7 py-4 text-xs text-ink-3">
              <span>
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
              </span>
              <span>
                <Kbd>↵</Kbd> do it
              </span>
              <span>
                <Kbd>Esc</Kbd> close
              </span>
            </footer>
          </Command>
        </DialogContent>
      </Dialog>

      <Dialog open={keysOpen} onOpenChange={setKeysOpen}>
        <DialogContent className="p-10">
          <DialogTitle className="font-display text-xl font-semibold">
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-ink-2">
            Single keys do nothing while you are typing in a field
            {prefs.shortcuts ? '' : ', and are currently switched off'}.
          </DialogDescription>
          {(['Anywhere', 'Trade'] as const).map((group) => (
            <section key={group} className="mt-6">
              <h3 className="text-xs text-ink-3">{group}</h3>
              <dl className="mt-1">
                {SHORTCUTS.filter((item) => item.group === group).map((item) => (
                  <div
                    key={item.keys}
                    className="flex items-baseline justify-between gap-8 border-t border-line py-2"
                  >
                    <dt className="text-md">{item.does}</dt>
                    <dd className="num whitespace-nowrap text-sm font-medium">{item.keys}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </DialogContent>
      </Dialog>
    </>
  );
}
