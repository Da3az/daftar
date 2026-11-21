import { Select as S } from 'radix-ui';
import { cn } from '@/lib/cn';
import { floating } from './overlay';

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <S.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <S.Trigger
        aria-label={label}
        className={cn(
          'flex h-15 items-center justify-between gap-6 rounded-field border-[length:var(--border-field)] border-field bg-surface px-5 text-md',
          className,
        )}
      >
        <S.Value />
        <S.Icon className="text-xs text-ink-3">▼</S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          className={cn(floating, 'min-w-(--radix-select-trigger-width) p-2')}
        >
          <S.Viewport>
            {options.map((option) => (
              <S.Item
                key={option.value}
                value={option.value}
                className="flex cursor-default items-center justify-between gap-8 rounded-tag px-4 py-3 text-md outline-none data-[highlighted]:bg-well data-[state=checked]:font-semibold"
              >
                <S.ItemText>{option.label}</S.ItemText>
                <S.ItemIndicator className="text-xs text-ink-3">selected</S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
