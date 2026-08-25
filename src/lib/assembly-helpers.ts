import { basename, join, sep } from "node:path";
import type { MapEdge } from "./map-types.ts";
import { readText } from "./read.ts";
import { titleCase } from "./text.ts";

/** Appends the edge unless an edge with the same id is already present. */
export function addEdge(edges: MapEdge[], edge: MapEdge): void {
    if (edges.some((e) => e.id === edge.id)) return;
    edges.push(edge);
}

/** Decodes an "a->b" edge key into its endpoints, throwing on a malformed key. */
export function splitEdgeKey(key: string): [string, string] {
    const [from, to] = key.split("->");
    if (from === undefined || to === undefined) throw new Error(`Malformed edge key: ${key}`);
    return [from, to];
}

/** Sums the line counts of the given repo-relative files. */
export function linesOf(repo: string, files: readonly string[]): number {
    return files.reduce((sum, f) => sum + readText(join(repo, f)).split("\n").length, 0);
}

/** Human label for a room segment: "(root)" reads as the top-level files, paths as title-cased segments. */
export function roomLabel(segment: string): string {
    return segment === "(root)" ? "Top-level files" : titleCase(segment.split(sep).join(" / "));
}

/** Module name for a source file: its basename minus the extension. */
export function fileModuleName(file: string): string {
    return basename(file).replace(/\.[a-z]+$/, "");
}

/** Suffixes the base id with -2, -3, ... until the taken predicate reports it free. */
export function uniqueId(base: string, taken: (id: string) => boolean): string {
    let id = base;
    for (let n = 2; taken(id); n += 1) id = `${base}-${n}`;
    return id;
}

/** Sanitises a node id for use as a mermaid identifier. */
export function mermaidId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Building footprint from the worst single-function complexity, clamped to [0.95, 2.5]. */
export function footprintFor(complexity: number): number {
    return Math.min(2.5, Math.max(0.95, 0.85 + Math.sqrt(complexity) / 4));
}

/** Pattern matching an import or require of the given dependency name. */
export function sdkImportPattern(depName: string): RegExp {
    const escaped = depName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(from\\s+|require\\()["']${escaped}`);
}

/** Pattern matching a reference to an external system by SDK import or env-var prefix. */
export function externalReferencePattern(name: string): RegExp {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`from\\s+["'][^"']*${escaped}|\\b${escaped.toUpperCase()}_[A-Z]`);
}
