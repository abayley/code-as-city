// Small shared helpers for both assembly pipelines: edge bookkeeping, id and
// label shaping, and the reference patterns the inference passes match (the
// shared vocabulary noted in HEURISTICS.md alongside map-types.ts).

import { basename, dirname, join, sep } from "node:path";
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
    if (segment === "(root)") return "Top-level files";
    // The universal `src` root conveys nothing when it prefixes a real segment
    // (`src/core` reads better as "Core"); drop it, but keep a bare `src` room
    // (its own loose files) labelled "Src" (HC-003).
    const parts = segment.split(sep);
    const shown = parts.length > 1 && parts[0] === "src" ? parts.slice(1) : parts;
    return titleCase(shown.join(" / "));
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
 * Display name for a module file: its module name, except a barrel file
 * (`index`/`mod`) is named for the directory it indexes rather than the
 * uninformative "Index" that collides across a whole repo (HC-004). Used for
 * labels only; ids and matching keep {@link fileModuleName}.
 *
 * @param file - Repo-relative path of the source file.
 * @returns The directory name for a barrel, else the module name.
 */
export function barrelAwareName(file: string): string {
    const name = fileModuleName(file);
    if (/^(index|mod)$/i.test(name)) {
        const dir = basename(dirname(file));
        if (dir && dir !== ".") return dir;
    }
    return name;
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

// Deployment structures aggregate whole services, so their worst-function
// complexity pushes footprints to the shared 2.5 ceiling far more often than
// overview modules do. At 2.5 the rendered base (2.5 * the viewer's 0.8 marker
// scale = 2.0) exactly fills the 2.0 layout step, leaving no ground between a
// building and the row behind it for that row's nameplate. Viewed from
// overhead, that buries the rear nameplates. A tighter deployment ceiling keeps
// a gap: 2.0 * 0.8 = 1.6 < 2.0. Overview keeps the wider ceiling.
const DEPLOYMENT_FOOTPRINT_CEILING = 2.0;

/**
 * Building footprint for a deployment node: {@link footprintFor} re-clamped to a
 * lower ceiling so that, viewed from overhead, a structure's base never grows
 * wide enough to overlap the nameplate of the row behind it. Deployment nodes
 * are multi-file service aggregates whose complexity would otherwise peg them to
 * the shared ceiling; overview modules keep {@link footprintFor} unchanged.
 *
 * @param complexity - The node's worst single-function McCabe complexity.
 * @returns The floor-area multiplier, never exceeding the deployment ceiling.
 */
export function deploymentFootprintFor(complexity: number): number {
    return Math.min(DEPLOYMENT_FOOTPRINT_CEILING, footprintFor(complexity));
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
 * The ids of the entries whose source imports any of the given SDK dependency
 * names (D17), in entry order, each id once. Shared by the deployment and
 * overview external-service passes.
 *
 * @param depNames - The client-SDK dependency names to detect imports of.
 * @param entries - `{ id, files }` records to scan.
 * @param fileText - Reads a repo-relative file's text.
 * @returns The importing entry ids, de-duplicated, in first-match order.
 */
export function sdkImporterIds(
    depNames: readonly string[],
    entries: readonly { id: string; files: readonly string[] }[],
    fileText: (file: string) => string,
): string[] {
    const patterns = depNames.map((dep) => sdkImportPattern(dep));
    const importerIds: string[] = [];
    for (const entry of entries) {
        if (!entry.files.some((file) => patterns.some((pattern) => pattern.test(fileText(file))))) continue;
        if (!importerIds.includes(entry.id)) importerIds.push(entry.id);
    }
    return importerIds;
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
