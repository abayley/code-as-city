// Text-shaping helpers for node ids and mechanical labels (no HEURISTICS.md
// rule group of its own).

/**
 * Kebab-cases arbitrary text for use in node ids; never returns an empty string.
 *
 * @param text - The text to flatten.
 * @returns Lower-case dash-separated alphanumerics, or "x" when nothing
 *   survives.
 */
export function kebab(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "x"
    );
}

/**
 * Title-cases dash/underscore-separated text for mechanical labels.
 *
 * @param text - The text to label (dashes and underscores become spaces).
 * @returns The space-separated text with each word capitalised.
 */
export function titleCase(text: string): string {
    return (
        text
            // Emoji leak into labels from names the generator does not control —
            // notably CI workflow names ("Release 🚀"). Strip pictographs, variation
            // selectors, and ZWJ joiners, then tidy the whitespace they leave (HC-006).
            .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "")
            .replace(/[-_]/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .replace(/\s+/g, " ")
            .trim()
    );
}
