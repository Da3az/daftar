import { ToggleGroup as G } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Tailwind classes for the selected state; defaults to the brand fill. */
  selectedClass?: string;
}

/** An either/or switch: a pill track with one filled segment. One option is always selected. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'sm',
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  label: string;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  return (
    <G.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
      aria-label={label}
      className={cn(
        'inline-flex rounded-pill border border-line bg-well p-1',
        size === 'lg' && 'flex w-full p-1.5',
        className,
      )}
    >
      {options.map((option) => (
        <G.Item
          key={option.value}
          value={option.value}
          className={cn(
            'whitespace-nowrap rounded-pill text-ink-2',
            size === 'sm'
              ? 'px-6 py-1 text-sm font-medium'
              : 'flex-1 py-4 font-display text-lg font-semibold',
            option.selectedClass ?? 'data-[state=on]:bg-brand data-[state=on]:text-on-brand',
          )}
        >
          {option.label}
        </G.Item>
      ))}
    </G.Root>
  );
}
