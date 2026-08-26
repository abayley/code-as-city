// Small shared helpers for both assembly pipelines: edge bookkeeping, id and
// label shaping, and the reference patterns the inference passes match (the
// shared vocabulary noted in HEURISTICS.md alongside map-types.ts).

import { basename, join, sep } from "node:path";
import type { MapEdge } from "./map-types.ts";
import { readText } from "./read.ts";
import { titleCase } from "./text.ts";

/**
 * Appends the edge unless an edge with the same id is already present.
 *
 * @param edges - The map's accumulating edge list, mutated in place.
 * @param edge - The candidate edge; dropped when its id is already taken.
 */
export function addEdge(edges: MapEdge[], edge: MapEdge): void {
    if (edges.some((e) => e.id === edge.id)) return;
    edges.push(edge);
}

/**
 * Decodes an "a->b" edge key into its endpoints, throwing on a malformed key.
 *
 * @param key - An edge key of the form "from->to", as used by the room and
 *   package edge maps.
 * @returns The [from, to] endpoint ids.
 */
export function splitEdgeKey(key: string): [string, string] {
    const [from, to] = key.split("->");
    if (from === undefined || to === undefined) throw new Error(`Malformed edge key: ${key}`);
    return [from, to];
}

/**
 * Sums the line counts of the given repo-relative files.
 *
 * @param repo - Absolute path of the repository being mapped.
 * @param files - Repo-relative paths of the files to count.
 * @returns The total number of lines across the files (unreadable files
 *   count as one line, the empty string).
 */
export function linesOf(repo: string, files: readonly string[]): number {
    return files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
}

/**
 * Human label for a room segment: "(root)" reads as the top-level files, paths as title-cased segments.
 *
 * @param segment - The room's path segment within its package, or "(root)".
 * @returns The display label for the room.
 */
export function roomLabel(segment: string): string {
    return segment === "(root)" ? "Top-level files" : titleCase(segment.split(sep).join(" / "));
}

/**
 * Module name for a source file: its basename minus a lower-case
 * extension. Only the final `.ext` is stripped, so `x.d.ts` yields `x.d`,
 * and an upper-case extension is left in place.
 *
 * @param file - Repo-relative path of the source file.
 * @returns The extension-less basename used as the module's name.
 */
export function fileModuleName(file: string): string {
    return basename(file).replace(/\.[a-z]+$/, "");
}

/**
 * Suffixes the base id with -2, -3, ... until the taken predicate reports it free.
 *
 * @param base - The preferred id (kebab-flattened collisions get suffixed).
 * @param taken - Reports whether an id is already claimed by another node.
 * @returns The first free id: the base itself, or base-2, base-3, ...
 */
export function uniqueId(base: string, taken: (id: string) => boolean): string {
    let id = base;
    for (let n = 2; taken(id); n += 1) id = `${base}-${n}`;
    return id;
}

/**
 * Sanitises a node id for use as a mermaid identifier.
 *
 * @param id - The map node id, which may contain characters mermaid rejects.
 * @returns The id with every character outside [A-Za-z0-9_] replaced by
 *   "_"; underscores already present are kept.
 */
export function mermaidId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Building footprint from the worst single-function complexity, clamped to [0.95, 2.5].
 * The O5 floor-area formula, shared with deployment nodes via M11.
 *
 * @param complexity - The node's worst single-function McCabe complexity.
 * @returns The floor-area multiplier for the rendered building.
 */
export function footprintFor(complexity: number): number {
    return Math.min(2.5, Math.max(0.95, 0.85 + Math.sqrt(complexity) / 4));
}

/**
 * Escapes a string for literal use inside a regular expression. Every value
 * interpolated into a `RegExp` here comes from the target repository, so an
 * unescaped metacharacter would either throw or silently mismatch.
 *
 * @param text - Arbitrary text read from the repository under inspection.
 * @returns The text with every regex metacharacter backslash-escaped.
 */
export function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pattern matching an import or require of the given dependency name.
 *
 * @param depName - The npm dependency name as declared in package.json
 *   (regex metacharacters are escaped).
 * @returns A pattern that matches `from "dep"` / `require("dep"` forms.
 */
export function sdkImportPattern(depName: string): RegExp {
    return new RegExp(`(from\\s+|require\\()["']${escapeRegex(depName)}`);
}

/**
 * Pattern matching a reference to an external system by SDK import or env-var prefix
 * (the M10/O8 "delivers" signal).
 *
 * @param name - The external system's normalised name (lower-case
 *   alphanumeric; regex metacharacters are escaped).
 * @returns A pattern matching an import specifier containing the name or an
 *   upper-cased NAME_* environment-variable prefix.
 */
export function externalReferencePattern(name: string): RegExp {
    const escaped = escapeRegex(name);
    return new RegExp(`from\\s+["'][^"']*${escaped}|\\b${escaped.toUpperCase()}_[A-Z]`);
}
