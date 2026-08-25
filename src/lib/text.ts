/** Kebab-cases arbitrary text for use in node ids; never returns an empty string. */
export function kebab(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "x"
    );
}

/** Title-cases dash/underscore-separated text for mechanical labels. */
export function titleCase(text: string): string {
    return text.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
