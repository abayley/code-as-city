/**
 * Overview-map assembly phases extracted from `assemble-overview.ts`. Each
 * function is one block of the overview pipeline: it takes the accumulators it
 * appends to plus the narrow slice of context it needs, and mutates them in
 * place, mirroring the pass style of `inference.ts`. The shared domain types
 * (module/district/infra shapes) live here so both files reference one
 * definition. Rule IDs (O8, O11) refer to HEURISTICS.md.
 */
import { addEdge, splitEdgeKey } from "./assembly-helpers.ts";
import { inferEmbeddedDatabaseUse, inferExternalDelivers, inferModuleDataFlows } from "./inference.ts";
import type { FileEdge, MapEdge } from "./map-types.ts";
import type { EmbeddedDatabase } from "./scans.ts";

/** An overview module: a source file (or a collapsed group) drawn as a structure. */
export type OverviewModule = {
    id: string;
    label: string;
    sublabel?: string | null | undefined;
    files: string[];
    path: string;
    support: boolean;
    collapsed?: boolean | undefined;
};

/** A directory- or package-district of overview modules, banded by deployment role. */
export type OverviewDistrict = {
    id: string;
    label: string;
    path: string;
    modules: OverviewModule[];
    // Assigned by the banding pass before any read.
    hosts: string[];
    band: number;
};

/** A deployment-infra node in the overview (a host service, database, or external). */
export type InfraMember = {
    id: string;
    label: string;
    archetype: string;
    kind: string;
    description: string;
    path: string;
    hostName?: string | undefined;
    external?: boolean | undefined;
    depName?: string | undefined;
};

/** A band-grouped district of infra members. */
export type InfraDistrict = { id: string; label: string; band: number; members: InfraMember[] };

/** A module-shaped record the inference passes classify: an id and its files. */
type ModuleEntry = { id: string; files: string[] };

/**
 * O8/O11 data-flow inference for the overview: OTLP producers into the gateway
 * collector, database reads/writes, embedded-database use, and delivers edges
 * to referenced externals. Each pass appends to `overviewEdges` in place; the
 * database preference for a district-local store is inert here by construction
 * (overview modules sit in directory districts, infra in host districts, so the
 * spaces never intersect and the overview always targets one database).
 *
 * @param options - `allModules` the module entries to classify; `uniqueInfra`
 *   the deduped infra members (source of the OTLP/database/external targets);
 *   `overviewEdges` the accumulator; `embeddedDatabases` the embedded stores;
 *   `fileText` to read source; `dbWritePattern`/`dbReadPattern` the SQL/ORM
 *   detectors.
 */
export function inferOverviewDataFlows(options: {
    allModules: readonly ModuleEntry[];
    uniqueInfra: readonly InfraMember[];
    overviewEdges: MapEdge[];
    embeddedDatabases: readonly EmbeddedDatabase[];
    fileText: (file: string) => string;
    dbWritePattern: RegExp;
    dbReadPattern: RegExp;
}): void {
    const { allModules, uniqueInfra, overviewEdges, embeddedDatabases, fileText, dbWritePattern, dbReadPattern } =
        options;
    // Remaining data-flow edges: OTLP producers into the gateway collector, and
    // database reads/writes.
    const otlpTarget =
        uniqueInfra.find((m) => /collector/.test(m.id) && /gateway/.test(m.id)) ??
        uniqueInfra.find((m) => /collector/.test(m.id));
    // The shared pass prefers a district-local database and falls back to the
    // first. That preference is inert here by construction, not by oversight:
    // overview modules sit in directory districts while infra members sit in
    // host districts, so the two district spaces never intersect and the
    // overview always targets one database. See BACKLOG "Mode differences by
    // design".
    const databaseTarget = uniqueInfra.find((m) => m.archetype === "database");
    inferModuleDataFlows({
        entries: allModules,
        edges: overviewEdges,
        fileText,
        ...(otlpTarget ? { otlpTargetId: otlpTarget.id } : {}),
        ...(databaseTarget
            ? {
                  database: {
                      databases: [{ id: databaseTarget.id }],
                      writePattern: dbWritePattern,
                      readPattern: dbReadPattern,
                  },
              }
            : {}),
    });
    // Modules importing an embedded database's SDK read/write that database.
    inferEmbeddedDatabaseUse({
        databases: embeddedDatabases,
        entries: allModules,
        edges: overviewEdges,
        fileText,
        edgeSuffix: "-u",
    });
    // Modules that reference an external by SDK import or env-var prefix
    // deliver data to it (src/delivery pushing scores into Langfuse/Latitude).
    inferExternalDelivers({
        externals: uniqueInfra.filter((m) => m.external),
        entries: allModules,
        edges: overviewEdges,
        fileText,
    });
}

/**
 * Import edges for the overview, aggregated per module pair. The viewer never
 * draws these at rest — they appear only when a node is selected — so they cost
 * map size, not visual noise.
 *
 * @param options - `overviewEdges` the accumulator; `fileEdges` the file-level
 *   import edges; `fileToModule` the file-to-module-node index.
 */
export function addOverviewImportEdges(options: {
    overviewEdges: MapEdge[];
    fileEdges: readonly FileEdge[];
    fileToModule: ReadonlyMap<string, string>;
}): void {
    const { overviewEdges, fileEdges, fileToModule } = options;
    const importCounts = new Map<string, number>();
    for (const { from, to } of fileEdges) {
        const a = fileToModule.get(from);
        const b = fileToModule.get(to);
        if (!a || !b || a === b) continue;
        importCounts.set(`${a}->${b}`, (importCounts.get(`${a}->${b}`) ?? 0) + 1);
    }
    for (const [key, count] of importCounts) {
        const [from, to] = splitEdgeKey(key);
        addEdge(overviewEdges, {
            id: `${from}--${to}-i`,
            from,
            to,
            kind: "depends_on",
            evidence: "declared",
            label: `${count} import${count === 1 ? "" : "s"}`,
        });
    }
}
