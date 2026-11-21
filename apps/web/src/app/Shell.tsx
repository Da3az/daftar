import { NavLink, Outlet } from 'react-router';
import { freshness, useMarket, useMe } from '@/api/queries';
import { CopyButton, Kbd } from '@/components/bits';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toaster } from '@/components/ui/toaster';
import { cn } from '@/lib/cn';
import { groupHandle } from '@/lib/ids';
import { type Prefs, setPrefs, usePrefs } from '@/lib/prefs';
import { showTime } from '@/lib/time';
import { emit } from './actions';
import { CommandPalette } from './CommandPalette';
import { ReceiptSheet } from '@/features/history/Receipt';
import { useShortcuts } from './useShortcuts';

const NAV = [
  { to: '/', label: 'Trade' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/history', label: 'History' },
] as const;

/** The one permanent line: none of this is real. Never dismissible, at every width. */
function NoticeBand() {
  return (
    <p
      role="note"
      className="flex h-(--notice-height) flex-none items-center justify-center gap-3 overflow-hidden whitespace-nowrap bg-notice px-4 text-sm text-on-notice"
    >
      <b className="font-display font-bold">Play money.</b>
      <span className="hidden md:inline">
        This is a beta demo — no real coin, no real bank, and nothing here is an investment.
      </span>
      <span className="md:hidden">Beta demo — nothing here is real.</span>
    </p>
  );
}

function Freshness() {
  const market = useMarket();
  const { stale, empty, asOf } = freshness(market);
  if (empty)
    return (
      <span className="text-sm text-on-brand-muted">
        {market.isError ? 'Market unavailable — retrying every second' : 'Connecting…'}
      </span>
    );
  return (
    <span
      role="status"
      className={cn(
        'flex items-center gap-3 whitespace-nowrap text-sm',
        stale
          ? 'rounded-tag bg-notice px-4 py-1 font-medium text-on-notice'
          : 'text-on-brand-muted',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-4',
          stale ? 'border border-dashed border-on-notice' : 'rounded-pill bg-on-brand-muted',
        )}
      />
      {stale ? (
        <>
          Out of date since <span className="num">{showTime(asOf)}</span> UTC — retrying every
          second
        </>
      ) : (
        <>
          <span className="hidden xl:inline">Prices as of</span>{' '}
          <span className="num">{showTime(asOf)}</span> UTC
        </>
      )}
    </span>
  );
}

function Choice<K extends keyof Prefs>({
  pref,
  value,
  label,
}: {
  pref: K;
  value: Prefs[K];
  label: string;
}) {
  const prefs = usePrefs();
  return (
    <DropdownMenuItem onSelect={() => setPrefs({ [pref]: value })}>
      {label}
      {prefs[pref] === value && <span className="text-xs text-ink-3">on</span>}
    </DropdownMenuItem>
  );
}

function DisplayMenu() {
  const prefs = usePrefs();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="rounded-field border border-brand-line px-5 py-2 text-sm text-on-brand-muted">
        Display
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <Choice pref="theme" value="system" label="Follow this device" />
        <Choice pref="theme" value="light" label="Light" />
        <Choice pref="theme" value="dark" label="Dark" />
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Buy and sell colours</DropdownMenuLabel>
        <Choice pref="scheme" value="green-up" label="Green buys, red sells" />
        <Choice pref="scheme" value="red-up" label="Red buys, green sells" />
        <Choice pref="scheme" value="blue-orange" label="Blue buys, orange sells" />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setPrefs({ flash: !prefs.flash })}>
          Flash changed numbers
          <span className="text-xs text-ink-3">{prefs.flash ? 'on' : 'off'}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPrefs({ shortcuts: !prefs.shortcuts })}>
          Single-key shortcuts
          <span className="text-xs text-ink-3">{prefs.shortcuts ? 'on' : 'off'}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => emit('daftar:keys')}>
          Keyboard shortcuts<Kbd>?</Kbd>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Header() {
  const me = useMe().data;
  return (
    <header className="flex min-h-(--header-height) flex-none flex-wrap items-center gap-x-8 gap-y-2 bg-header px-4 py-3 text-on-brand md:px-10">
      <NavLink
        to="/"
        className="flex items-baseline gap-4 rounded-tag font-display text-2xl font-bold leading-none tracking-tight"
      >
        daftar{' '}
        <span lang="ar" dir="rtl" className="font-ui text-lg font-normal opacity-80">
          دفتر
        </span>
      </NavLink>
      <nav aria-label="Pages" className="flex gap-1">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end
            className={({ isActive }) =>
              cn(
                'rounded-pill px-6 py-3 text-md font-medium',
                isActive ? 'bg-on-brand text-header' : 'text-on-brand-muted',
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-6 gap-y-2">
        <Freshness />
        <button
          type="button"
          onClick={() => emit('daftar:palette')}
          className="hidden items-center gap-4 rounded-field border border-brand-line px-5 py-2 text-sm text-on-brand-muted md:flex"
        >
          Search actions <Kbd>Ctrl K</Kbd>
        </button>
        <DisplayMenu />
        {me ? (
          <div className="flex items-center gap-4 rounded-field bg-header-well py-1 pl-5 pr-1 text-sm">
            <span className="max-w-70 truncate" title={me.participant.displayName}>
              {me.participant.displayName}
            </span>
            <span
              className="num hidden text-on-brand-muted md:inline"
              title="Your public handle: give it to someone so they can send you cash"
            >
              {groupHandle(me.handle)}
            </span>
            <CopyButton text={me.handle} label="Copy handle" className="bg-on-brand text-header" />
          </div>
        ) : (
          <span className="rounded-field border border-brand-line px-5 py-2 text-sm text-on-brand-muted">
            Watching — not entered
          </span>
        )}
      </div>
    </header>
  );
}

export function Shell() {
  useShortcuts();
  return (
    <div className="flex min-h-dvh flex-col xl:h-dvh">
      <div className="sticky top-0 z-30 flex-none xl:static">
        <NoticeBand />
      </div>
      <Header />
      <main className="min-h-0 flex-1 xl:overflow-y-auto">
        <Outlet />
      </main>
      <CommandPalette />
      <ReceiptSheet />
      <Toaster />
    </div>
  );
}
