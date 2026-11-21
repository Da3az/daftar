import { ScrollArea as S } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/** Every panel and list that scrolls. The thumb shows on hover, focus and while scrolling. */
export function ScrollArea({
  className,
  children,
  horizontal = false,
  ...props
}: ComponentProps<typeof S.Root> & { horizontal?: boolean }) {
  return (
    <S.Root type="hover" className={cn('min-h-0 overflow-hidden', className)} {...props}>
      <S.Viewport className="size-full [&>div]:!block">{children}</S.Viewport>
      <S.Scrollbar orientation="vertical" className="flex w-4 touch-none p-px">
        <S.Thumb className="flex-1 rounded-pill bg-line-strong" />
      </S.Scrollbar>
      {horizontal && (
        <S.Scrollbar orientation="horizontal" className="flex h-4 touch-none flex-col p-px">
          <S.Thumb className="flex-1 rounded-pill bg-line-strong" />
        </S.Scrollbar>
      )}
    </S.Root>
  );
}
