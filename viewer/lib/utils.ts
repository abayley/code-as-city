import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class values and resolves conflicting Tailwind utilities, keeping the
 * last one wins. The shadcn class helper every generated component calls.
 *
 * @param inputs - Class names, arrays, or conditional objects, as clsx takes.
 * @returns One class string with Tailwind conflicts merged away.
 */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
