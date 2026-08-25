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
