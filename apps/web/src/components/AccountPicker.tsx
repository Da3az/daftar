import { useState } from 'react';
import { useCurrentAccount, useSetAccount } from '@/lib/account-store';
import { Button, Input } from '@/components/ui/primitives';

/**
 * Switch which seeded account the interface is viewing.
 *
 * A text field rather than a dropdown of every account: the seed has 1,000+ of
 * them, and an endpoint that lists all accounts so a demo can populate a
 * `<select>` is an account-enumeration endpoint. Typing an id that does not
 * exist produces a clean 404 on the page, which is the correct outcome.
 */
export function AccountPicker(): React.JSX.Element {
  const current = useCurrentAccount();
  const setAccount = useSetAccount();
  const [draft, setDraft] = useState(current);

  const apply = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length > 0) setAccount(trimmed);
  };

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <Input
        aria-label="Account external id"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="h-7 w-44 text-xs"
        spellCheck={false}
      />
      {/* type="submit" so Enter in the field works, which `Button` does not
          default to — see the note in primitives.tsx. */}
      <Button type="submit" size="sm">
        View
      </Button>
    </form>
  );
}
