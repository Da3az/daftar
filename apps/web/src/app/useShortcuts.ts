import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTicket } from '@/features/trade/ticketStore';
import { usePrefs } from '@/lib/prefs';
import { emit, submitTicket } from './actions';

const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** Keyboard shortcuts. Single keys never fire while typing and can be switched off; Ctrl combinations always work. */
export function useShortcuts(): void {
  const navigate = useNavigate();
  const ticket = useTicket();
  const { shortcuts } = usePrefs();
  const pendingG = useRef(0);
  const latest = useRef(ticket);
  latest.current = ticket;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        emit('daftar:palette');
        return;
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault();
        submitTicket();
        return;
      }
      if (mod || event.altKey || !shortcuts || typing(event.target)) return;
      const key = event.key.toLowerCase();
      if (Date.now() - pendingG.current < 1200) {
        pendingG.current = 0;
        const to = { t: '/', p: '/portfolio', h: '/history' }[key];
        if (to) {
          event.preventDefault();
          void navigate(to);
          return;
        }
      }
      const t = latest.current;
      switch (key) {
        case 'g':
          pendingG.current = Date.now();
          break;
        case '?':
          emit('daftar:keys');
          break;
        case 'b':
          t.setSide('buy');
          break;
        case 's':
          t.setSide('sell');
          break;
        case 'l':
          t.setType('limit');
          break;
        case 'm':
          t.setType('market');
          break;
        case '/':
          event.preventDefault();
          t.setType('limit');
          t.focusRef.current?.focus();
          break;
        case '1':
          emit('daftar:interval', '1m');
          break;
        case '2':
          emit('daftar:interval', '5m');
          break;
        case '3':
          emit('daftar:interval', '1h');
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, shortcuts]);
}
