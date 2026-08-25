// The shared inference passes both assembly pipelines apply (HEURISTICS.md
// M1/M8/M10/D13 shared with O8/O11). Each pass works over NodeIndexEntry
// records built per-mode: the deployment map from classificationSets and
// fileNodeOwner, the overview from allModules. The caller supplies the
// records in its own iteration order, so each mode's original edge order is
// replayed exactly; genuine divergences (edge id suffixes, guard asymmetries,
// target selection) surface as options.

import { addEdge, externalReferencePattern, sdkImportPattern } from "./assembly-helpers.ts";
import type { Host, HostService } from "./hosts.ts";
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
 * prefix deliver data to it. `guardTargets` preserves the deployment map's
 * self-id and empty-files guards; the overview lacks them (a recorded latent
 * divergence, kept as-is).
 */
export function inferExternalDelivers(options: {
    externals: readonly { id: string; label: string }[];
    entries: readonly NodeIndexEntry[];
    edges: MapEdge[];
    fileText: (file: string) => string;
    guardTargets: boolean;
}): void {
    for (const external of options.externals) {
        const name = external.label.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (name.length < 4) continue;
        const referencePattern = externalReferencePattern(name);
        for (const entry of options.entries) {
            if (options.guardTargets && (entry.id === external.id || !entry.files.length)) continue;
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
 * Collector selection and database targeting stay per-mode: the deployment
 * map prefers the district-local database, the overview always targets the
 * first (a recorded latent divergence, kept as-is).
 */
export function inferModuleDataFlows(options: {
    entries: readonly NodeIndexEntry[];
    edges: MapEdge[];
    fileText: (file: string) => string;
    otlpTargetId?: string | undefined;
    database?:
        | {
              chooseTarget: (entry: NodeIndexEntry) => string | undefined;
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
        const target = database.chooseTarget(entry);
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
