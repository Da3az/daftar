import type { LedgerEntry } from '@/api/types';
import { parseUnits, showCash, showQty } from '@/lib/money';

const decimalsOf = (unit: string): number => (unit === 'USD' ? 2 : 8);
const show = (amount: string | bigint, unit: string): string =>
  unit === 'USD' ? showCash(amount) : showQty(amount, 8);

/* Convention (as the mock engine emits): a debit takes value out of an account, a credit puts it in. */
/** The double-entry lines behind one event. Per unit, what left accounts equals what arrived — and the footer proves it. */
export function Ledger({ entries }: { entries: LedgerEntry[] }) {
  if (!entries || entries.length === 0)
    return <p className="text-sm text-ink-3">No ledger lines came with this event.</p>;
  const units = [...new Set(entries.map((entry) => entry.unit))];
  return (
    <div className="flex flex-col gap-5">
      {units.map((unit) => {
        const lines = entries.filter((entry) => entry.unit === unit);
        const sum = (direction: 'debit' | 'credit') =>
          lines
            .filter((line) => line.direction === direction)
            .reduce((total, line) => total + (parseUnits(line.amount, decimalsOf(unit)) ?? 0n), 0n);
        const out = sum('debit');
        const into = sum('credit');
        const balanced = out === into;
        return (
          <table key={unit} className="w-full border-collapse text-sm">
            <caption className="pb-1 text-left text-xs text-ink-3">Movement of {unit}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-ink-3">
                <th className="py-1 text-left font-medium">Account</th>
                <th className="py-1 text-right font-medium">
                  Out of <span className="font-normal">(debit)</span>
                </th>
                <th className="py-1 text-right font-medium">
                  Into <span className="font-normal">(credit)</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => (
                <tr key={index} className="border-b border-line">
                  <td className="max-w-90 truncate py-2 pr-4" title={line.account}>
                    {line.account}
                  </td>
                  <td className="num py-2 text-right">
                    {line.direction === 'debit' ? show(line.amount, unit) : ''}
                  </td>
                  <td className="num py-2 text-right">
                    {line.direction === 'credit' ? show(line.amount, unit) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink font-semibold">
                <td className="py-2">
                  {balanced ? (
                    <span className="text-success">Balanced: out equals in</span>
                  ) : (
                    <span className="text-danger">Does not balance</span>
                  )}
                </td>
                <td className="num py-2 text-right">{show(out, unit)}</td>
                <td className="num py-2 text-right">{show(into, unit)}</td>
              </tr>
            </tfoot>
          </table>
        );
      })}
    </div>
  );
}
