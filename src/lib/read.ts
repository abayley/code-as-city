// Forgiving file and JSON readers: every scan tolerates unreadable or
// malformed input rather than aborting the map (no heuristics of its own).

import { readFileSync } from "node:fs";

/**
 * Parses JSON text, returning undefined on any parse failure.
 *
 * @param text - The JSON text to parse.
 * @returns The parsed value, or undefined when the text is not valid JSON.
 */
export function readJsonSafe(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Reads and parses a JSON file, returning undefined when unreadable or invalid.
 *
 * @param path - Absolute path of the JSON file.
 * @returns The parsed value, or undefined on read or parse failure.
 */
export function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

/**
 * Reads a `key = "value"` entry from TOML-ish text, line-anchored so a key
 * ending in the same word elsewhere cannot match. Table-blind by decision
 * (like every line-based reader here): callers needing a section scope it
 * with {@link tomlSection} first.
 *
 * @param text - The config text to read.
 * @param key - The literal key name (no pattern characters).
 * @returns The quoted value, or null.
 */
export function tomlValue(text: string, key: string): string | null {
    return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m").exec(text)?.[1] ?? null;
}

/**
 * Scopes TOML-ish text to one `[section]`: the body after its header up to
 * the next section header (or end of file).
 *
 * @param text - The config text to scope.
 * @param section - The section name without brackets.
 * @returns The section body, or null when no such header exists.
 */
export function tomlSection(text: string, section: string): string | null {
    const start = text.search(new RegExp(`^\\[${section}\\]`, "m"));
    if (start === -1) return null;
    const afterHeader = text.slice(start).split("\n").slice(1).join("\n");
    return afterHeader.split(/^\[.*\]$/m)[0] ?? "";
}

/**
 * Parses dotenv text into a name/value map: `KEY=value` lines with `#`
 * comments and blank lines skipped and surrounding quotes stripped. Values
 * are kept raw — interpolation resolves against the caller's own scope.
 *
 * @param text - The `.env`-shaped text to parse.
 * @returns The entries found, in file order (later duplicates win).
 */
export function parseDotEnv(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = /^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(trimmed);
        const value = match?.[2]?.replace(/^["']|["']$/g, "");
        if (match?.[1] && value) env[match[1]] = value;
    }
    return env;
}

/**
 * Reads a text file, returning the empty string when unreadable.
 *
 * @param path - Absolute path of the text file.
 * @returns The file's contents, or "" on any read failure.
 */
export function readText(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}
