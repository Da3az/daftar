import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, with later Tailwind utilities winning over earlier ones in
 * the same group.
 *
 * `clsx` alone concatenates, so `"p-2"` and `"p-4"` would both survive and the
 * winner would depend on CSS source order rather than on call order. `twMerge`
 * resolves conflicts by group, which is what makes a `className` prop on a
 * styled component actually able to override the default.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
