import { readFileSync } from "node:fs";

/** Parses JSON text, returning undefined on any parse failure. */
export function readJsonSafe(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** Reads and parses a JSON file, returning undefined when unreadable or invalid. */
export function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

/** Reads a text file, returning the empty string when unreadable. */
export function readText(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}
