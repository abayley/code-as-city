// The shared inference passes both assembly pipelines apply (HEURISTICS.md
// M1/M8/M10/D13 shared with O8/O11). Each pass works over NodeIndexEntry
// records built per-mode: the deployment map from classificationSets and
// fileNodeOwner, the overview from allModules. The caller supplies the
// records in its own iteration order, so each mode's original edge order is
// replayed exactly; genuine divergences (edge id suffixes, guard asymmetries,
// target selection) surface as options.

import { sep } from "node:path";
import { addEdge, externalReferencePattern, fileModuleName, sdkImportPattern } from "./assembly-helpers.ts";
import type { Host, HostService } from "./hosts.ts";
import { ENTRY_FILE_PATTERN } from "./inventory.ts";
import type { MapEdge } from "./map-types.ts";
import type { EmbeddedDatabase } from "./scans.ts";
import { OTLP_PATTERN } from "./scans.ts";

/** The node-shaped record the shared inference passes consume. */
export type NodeIndexEntry = {
    id: string;
    files: readonly string[];
    districtId?: string | undefined;
    entryFile?: string | null | undefined;
};

/**
 * D13/O11: entries importing an embedded database's SDK read/write that
 * database. The caller controls importer discovery order by the order (and
 * granularity) of its entries — the deployment map passes one entry per
 * owned source file, the overview one per module — and duplicate entry ids
 * collapse to the first match. `onImporters` runs before the edges are
 * emitted, letting the deployment map create the database node parented into
 * its importers' district; the overview creates its node elsewhere and emits
 * "-u"-suffixed edge ids where the deployment map uses none.
 *
 * @param options - The pass inputs: `databases` — the embedded databases
 *   from the D13 scan; `entries` — the node-shaped records to test, in the
 *   mode's own order; `edges` — the accumulating edge list, mutated in
 *   place; `fileText` — reads a repo-relative file's text; `edgeSuffix` —
 *   appended to each edge id ("" for the deployment map, "-u" for the
 *   overview); `onImporters` — optional callback run per database with its
 *   importer ids before the edges are emitted.
 */
export function inferEmbeddedDatabaseUse(options: {
    databases: readonly EmbeddedDatabase[];
    entries: readonly NodeIndexEntry[];
    edges: MapEdge[];
    fileText: (file: string) => string;
    edgeSuffix: string;
    onImporters?: ((database: EmbeddedDatabase, importerIds: readonly string[]) => void) | undefined;
}): void {
    for (const database of options.databases) {
        const importPattern = sdkImportPattern(database.depName);
        const importerIds: string[] = [];
        for (const entry of options.entries) {
            if (!entry.files.some((file) => importPattern.test(options.fileText(file)))) continue;
            if (!importerIds.includes(entry.id)) importerIds.push(entry.id);
        }
        options.onImporters?.(database, importerIds);
        for (const importer of importerIds) {
            addEdge(options.edges, {
                id: `${importer}--${database.id}${options.edgeSuffix}`,
                from: importer,
                to: database.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.7,
                label: "reads/writes",
                sourceRefs: [{ path: database.path }],
            });
        }
    }
}

/**
 * M10/O8: entries referencing an external system by SDK import or env-var
 * prefix deliver data to it. Entries that are the external itself or carry
 * no files are skipped in both modes.
 *
 * @param options - The pass inputs: `externals` — the external-system nodes
 *   (M6/D11/D12) with display labels to match by; `entries` — the
 *   node-shaped records to test; `edges` — the accumulating edge list,
 *   mutated in place; `fileText` — reads a repo-relative file's text.
 */
export function inferExternalDelivers(options: {
    externals: readonly { id: string; label: string }[];
    entries: readonly NodeIndexEntry[];
    edges: MapEdge[];
    fileText: (file: string) => string;
}): void {
    for (const external of options.externals) {
        const name = external.label.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (name.length < 4) continue;
        const referencePattern = externalReferencePattern(name);
        for (const entry of options.entries) {
            if (entry.id === external.id || !entry.files.length) continue;
            if (!entry.files.some((file) => referencePattern.test(options.fileText(file)))) continue;
            addEdge(options.edges, {
                id: `${entry.id}--${external.id}-d`,
                from: entry.id,
                to: external.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.6,
                label: "delivers",
            });
        }
    }
}

/**
 * M1/M8 shared with O8: per-entry data-flow inference — OTLP producers into
 * the collector, and database writes/reads. The two sub-inferences live in
 * one pass because the overview interleaves them per module (its edge order
 * depends on it); the deployment map calls the pass twice, once per universe
 * (OTLP over promoted nodes, database flow over classification sets).
 * Collector selection stays per-mode; database targeting is shared — the
 * entry's district-local database wins, else the first declared.
 *
 * @param options - The pass inputs: `entries` — the node-shaped records to
 *   test, in the mode's own order; `edges` — the accumulating edge list,
 *   mutated in place; `fileText` — reads a repo-relative file's text;
 *   `otlpTargetId` — the collector node OTLP producers export to (omit to
 *   skip the M1 arm); `database` — the database nodes plus the SQL/ORM
 *   write and read patterns (omit to skip the M8 arm).
 */
export function inferModuleDataFlows(options: {
    entries: readonly NodeIndexEntry[];
    edges: MapEdge[];
    fileText: (file: string) => string;
    otlpTargetId?: string | undefined;
    database?:
        | {
              databases: readonly { id: string; districtId?: string | undefined }[];
              writePattern: RegExp;
              readPattern: RegExp;
          }
        | undefined;
}): void {
    for (const entry of options.entries) {
        const texts = entry.files.map((file) => options.fileText(file));
        const otlpTargetId = options.otlpTargetId;
        if (otlpTargetId !== undefined && texts.some((text) => OTLP_PATTERN.test(text))) {
            addEdge(options.edges, {
                id: `${entry.id}--${otlpTargetId}`,
                from: entry.id,
                to: otlpTargetId,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.7,
                label: "OTLP export",
            });
        }
        const database = options.database;
        if (!database) continue;
        const target = (database.databases.find((db) => db.districtId === entry.districtId) ?? database.databases[0])
            ?.id;
        if (target === undefined || target === entry.id) continue;
        if (texts.some((text) => database.writePattern.test(text))) {
            addEdge(options.edges, {
                id: `${entry.id}--${target}-w`,
                from: entry.id,
                to: target,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.75,
                label: "writes",
            });
        }
        if (texts.some((text) => database.readPattern.test(text))) {
            addEdge(options.edges, {
                id: `${target}--${entry.id}-r`,
                from: target,
                to: entry.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.75,
                label: "reads",
            });
        }
    }
}

/**
 * D1/D6/O7 shared record source: the image-classified services declared
 * across compose variants, in candidate-host then service order. The gating
 * stays per-mode by decision (the modes' conditions genuinely differ): the
 * deployment map keeps the first service per name for depends_on backfill;
 * the overview keeps non-built store-class services and attributes them to
 * the surviving host sharing the variant's service names.
 *
 * @param candidateHosts - Every compose-variant host, including deduped
 *   environment variants.
 * @returns Each image-classified service paired with the variant declaring
 *   it, in candidate-host then service order.
 */
export function classifiedVariantServices(
    candidateHosts: readonly Host[],
): { candidate: Host; service: HostService }[] {
    const classified: { candidate: Host; service: HostService }[] = [];
    for (const candidate of candidateHosts) {
        for (const service of candidate.services) {
            if (service.imageClass !== undefined) classified.push({ candidate, service });
        }
    }
    return classified;
}

/**
 * M3/O2 entry classification, one function with the per-granularity arms
 * explicit. A file referenced from a package.json script is a DECLARED entry
 * in every mode. Name-based arms differ by documented rule: the overview's
 * modules (O2) also qualify via an entry-dir path segment or an entry-named
 * file, but only when not imported (support modules are plumbing); the
 * deployment map's residual children (M3) qualify only as a single
 * entry-named loose file.
 *
 * @param options - The classification inputs: `files` — the node's files;
 *   `scriptReferencedFiles` — files named directly by package.json script
 *   commands (R1's script roots); `nameArm` — the optional name-based arm:
 *   for overview modules, the module path, its imported/support status, and
 *   the entry-dir name set; for deployment residual children, the child's
 *   path segment.
 * @returns Whether the node classifies as a gateway (entry point).
 */
export function isEntryPoint(options: {
    files: readonly string[];
    scriptReferencedFiles: ReadonlySet<string>;
    nameArm?:
        | { granularity: "module"; path: string; support: boolean; entryDirNames: ReadonlySet<string> }
        | { granularity: "child"; seg: string }
        | undefined;
}): boolean {
    if (options.files.some((file) => options.scriptReferencedFiles.has(file))) return true;
    const arm = options.nameArm;
    if (arm === undefined) return false;
    if (arm.granularity === "module") {
        return (
            !arm.support &&
            (arm.path.split(sep).some((seg) => arm.entryDirNames.has(seg)) ||
                ENTRY_FILE_PATTERN.test(fileModuleName(arm.path)))
        );
    }
    return options.files.length === 1 && ENTRY_FILE_PATTERN.test(arm.seg);
}
