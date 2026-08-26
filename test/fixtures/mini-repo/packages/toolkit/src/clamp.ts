/** Clamps a value to the inclusive range [low, high]. */
export function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), high);
}
