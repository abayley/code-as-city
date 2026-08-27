/**
 * Overview-map assembly phases extracted from `assemble-overview.ts`. Each
 * function is one block of the overview pipeline: it takes the accumulators it
 * appends to plus the narrow slice of context it needs, and mutates them in
 * place, mirroring the pass style of `inference.ts`. The shared domain types
 * (module/district/infra shapes) live here so both files reference one
 * definition. Rule IDs (O8, O11) refer to HEURISTICS.md.
 */
import { addEdge, sdkImporterIds, splitEdgeKey } from "./assembly-helpers.ts";
import type { HostScanResult } from "./host-config.ts";
import { type Host, isServiceShadowed } from "./hosts.ts";
import {
    classifiedVariantServices,
    inferEmbeddedDatabaseUse,
    inferExternalDelivers,
    inferModuleDataFlows,
} from "./inference.ts";
import type { FileEdge, MapEdge, MapNode } from "./map-types.ts";
import type { EmbeddedDatabase, ExternalServiceDep } from "./scans.ts";
import { kebab, titleCase } from "./text.ts";
import type { EdgeHost } from "./wrangler.ts";

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
type InfraMember = {
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
type InfraDistrict = { id: string; label: string; band: number; members: InfraMember[] };

/** A module-shaped record the inference passes classify: an id and its files. */
type ModuleEntry = { id: string; files: string[] };

/**
 * O7/O11/D17: builds the overview's infrastructure and external-system nodes.
 * Image-only compose services and their backing stores sit in their host's
 * district and band; config-declared receivers, the wrangler worker, the
 * drizzle and embedded databases, and client-SDK externals each become an infra
 * or external member. OTLP export/forward edges and D17 "uses" edges append to
 * `overviewEdges`; the deduped members are grouped into band-ordered infra
 * districts whose scope and member nodes append to `overviewNodes`.
 *
 * @param options - The `overviewNodes`/`overviewEdges` accumulators; the
 *   deployment-shape inputs (`hostScan`, `serviceOwner`, `hosts`,
 *   `candidateHosts`, `edgeHost`, `drizzleConfig`, `embeddedDatabases`,
 *   `externalServiceDeps`); the module handoffs `fileToModule`/`allModules` and
 *   `fileText` for D17 importer detection; the band helpers `hostBand`/
 *   `bandLabel` and the `externalsBand`/`sharedBand` constants; and
 *   `infraColor` for the node fill.
 * @returns The deduplicated infra members, in first-seen order, for the
 *   data-flow inference phase.
 */
export function assembleInfraDistricts(options: {
    overviewNodes: MapNode[];
    overviewEdges: MapEdge[];
    hostScan: readonly HostScanResult[];
    serviceOwner: ReadonlyMap<string, string>;
    hosts: readonly Host[];
    candidateHosts: readonly Host[];
    edgeHost: EdgeHost | null;
    drizzleConfig: string | undefined;
    embeddedDatabases: readonly EmbeddedDatabase[];
    externalServiceDeps: readonly ExternalServiceDep[];
    fileToModule: ReadonlyMap<string, string>;
    allModules: readonly ModuleEntry[];
    fileText: (file: string) => string;
    hostBand: (hostName: string) => number;
    bandLabel: (band: number) => string;
    externalsBand: number;
    sharedBand: number;
    infraColor: string;
}): InfraMember[] {
    const {
        overviewNodes,
        overviewEdges,
        hostScan,
        serviceOwner,
        hosts,
        candidateHosts,
        edgeHost,
        drizzleConfig,
        embeddedDatabases,
        externalServiceDeps,
        fileToModule,
        allModules,
        fileText,
        hostBand,
        bandLabel,
        externalsBand,
        sharedBand,
        infraColor,
    } = options;
    const infraMembers: InfraMember[] = [];
    /**
     * Picks the infra node that represents a host in OTLP wiring: the
     * collector/gateway/ingest-named image-only service when one exists, else
     * the first image-only service.
     *
     * @param host - Deployment host whose representative collector is wanted.
     * @returns The infra member's node id, or null when the host has no
     *   image-only services.
     */
    const infraCollectorFor = (host: Host) => {
        const candidates = host.services.filter((s) => !s.dockerfile);
        const pick = candidates.find((s) => /collector|gateway|ingest/.test(s.name)) ?? candidates[0];
        return pick ? kebab(`infra-${host.name}-${pick.name}`) : null;
    };
    // Per-host infrastructure: services and backing stores sit in their host's
    // district (and band), so postgres lives beside the evaluation modules.
    // Externals get their own district behind the last host.
    for (const scan of hostScan) {
        const host = scan.host;
        for (const service of host.services) {
            if (service.dockerfile) continue; // built from this repo's modules
            // D1: a service owned by another topology's canonical file folds to
            // that owner; it is not redrawn under this host.
            if (isServiceShadowed(serviceOwner, host, service.name)) continue;
            infraMembers.push({
                id: kebab(`infra-${host.name}-${service.name}`),
                label: titleCase(service.name),
                archetype: service.imageClass ?? "cloud",
                kind: "infra",
                description: `${service.image ?? "container"} on the ${host.name} host.`,
                path: host.file,
                hostName: host.name,
            });
        }
        const from = infraCollectorFor(host);
        for (const { candidate, config } of scan.externals) {
            const externalId = kebab(`external-${candidate}`);
            infraMembers.push({
                id: externalId,
                label: titleCase(candidate),
                archetype: "cloud",
                kind: "external",
                description: `External receiver declared in ${config}.`,
                path: config,
                external: true,
            });
            if (from) {
                addEdge(overviewEdges, {
                    id: `${from}--${externalId}`,
                    from,
                    to: externalId,
                    kind: "data_flow",
                    evidence: "declared",
                    label: "OTLP export",
                    sourceRefs: [{ path: config }],
                });
            }
        }
        if (from) {
            for (const target of scan.hostTargets) {
                const other = hosts.find((h) => h.name === target);
                const to = other ? infraCollectorFor(other) : null;
                if (to) {
                    const forwardConfig = scan.configs[0];
                    if (forwardConfig === undefined)
                        throw new Error(`host ${host.name} has host targets but no configs`);
                    addEdge(overviewEdges, {
                        id: `${from}--${to}`,
                        from,
                        to,
                        kind: "data_flow",
                        evidence: "declared",
                        label: "OTLP forward",
                        sourceRefs: [{ path: forwardConfig }],
                    });
                }
            }
            for (const { service, config } of scan.serviceTargets) {
                const targetModule = service.entryFile ? fileToModule.get(service.entryFile) : null;
                if (targetModule) {
                    addEdge(overviewEdges, {
                        id: `${from}--${targetModule}`,
                        from,
                        to: targetModule,
                        kind: "data_flow",
                        evidence: "declared",
                        label: "OTLP forward",
                        sourceRefs: [{ path: config }],
                    });
                }
            }
        }
    }
    // Backing stores that only exist in deduped compose variants (the dev
    // compose's postgres container) are attributed to the surviving host that
    // shares that variant's services.
    for (const { candidate, service } of classifiedVariantServices(candidateHosts)) {
        const imageClass = service.imageClass;
        if (imageClass === undefined || !["database", "queue", "storage"].includes(imageClass) || service.dockerfile)
            continue;
        const variantServiceNames = new Set(candidate.services.map((s) => s.name));
        const owner = hosts.find((h) => h.services.some((s) => variantServiceNames.has(s.name)));
        infraMembers.push({
            id: kebab(`infra-${service.name}`),
            label: titleCase(service.name),
            archetype: imageClass,
            kind: "infra",
            description: `${service.image ?? "container"} declared in ${candidate.file}.`,
            path: candidate.file,
            hostName: owner?.name,
        });
    }
    if (edgeHost)
        infraMembers.push({
            id: "infra-cloudflare-worker",
            label: "Cloudflare Worker",
            archetype: "worker",
            kind: "infra",
            description: `Declared in ${edgeHost.file}.`,
            path: edgeHost.file,
        });
    if (drizzleConfig)
        infraMembers.push({
            id: "infra-drizzle-database",
            label: "Database",
            archetype: "database",
            kind: "infra",
            description: `Declared in ${drizzleConfig}.`,
            path: drizzleConfig,
        });
    const embeddedDbMembers = embeddedDatabases.map(
        (db): InfraMember => ({
            id: db.id,
            label: db.label,
            archetype: "database",
            kind: "infra",
            description: db.description,
            path: db.path,
            depName: db.depName,
        }),
    );
    infraMembers.push(...embeddedDbMembers);
    // D17: external services imported by a module become external cloud nodes
    // with an inferred "uses" edge, as in the deployment map — one per service,
    // drawn only when a module actually imports the client SDK.
    for (const service of externalServiceDeps) {
        const importerIds = sdkImporterIds(service.depNames, allModules, fileText);
        if (importerIds.length === 0) continue;
        infraMembers.push({
            id: service.id,
            label: service.label,
            archetype: "cloud",
            kind: "external",
            external: true,
            description: service.description,
            path: service.path,
        });
        for (const importer of importerIds) {
            addEdge(overviewEdges, {
                id: `${importer}--${service.id}-u`,
                from: importer,
                to: service.id,
                kind: "data_flow",
                evidence: "inferred",
                confidence: 0.7,
                label: "uses",
                sourceRefs: [{ path: service.path }],
            });
        }
    }
    const seenInfra = new Set<string>();
    const uniqueInfra = infraMembers.filter((m) => !seenInfra.has(m.id) && seenInfra.add(m.id));
    const infraDistricts = new Map<string, InfraDistrict>();
    for (const m of uniqueInfra) {
        const key = m.external
            ? "external-systems"
            : m.hostName
              ? kebab(`host-${m.hostName}`)
              : "infrastructure-district";
        let infraDistrict = infraDistricts.get(key);
        if (!infraDistrict) {
            infraDistrict = {
                id: key,
                label: m.external
                    ? "External systems"
                    : m.hostName
                      ? `${titleCase(m.hostName)} host`
                      : "Infrastructure",
                band: m.external ? externalsBand : m.hostName ? hostBand(m.hostName) : sharedBand,
                members: [],
            };
            infraDistricts.set(key, infraDistrict);
        }
        infraDistrict.members.push(m);
    }
    for (const infraDistrict of [...infraDistricts.values()].sort((a, b) => a.band - b.band)) {
        overviewNodes.push({
            id: infraDistrict.id,
            label: infraDistrict.label,
            kind: "scope",
            archetype: "district",
            description: `${infraDistrict.label}: ${infraDistrict.members.length} node${infraDistrict.members.length === 1 ? "" : "s"}.`,
            tags: [`band:${bandLabel(infraDistrict.band)}`],
            display: { color: infraColor, flowLayer: infraDistrict.band },
        });
        for (const m of infraDistrict.members) {
            overviewNodes.push({
                id: m.id,
                label: m.label,
                kind: m.kind,
                archetype: m.archetype,
                parentId: infraDistrict.id,
                description: m.description,
                sourceRefs: [{ path: m.path }],
                ...(m.hostName ? { tags: [`host:${m.hostName}`] } : {}),
                display: { color: infraColor },
            });
        }
    }
    return uniqueInfra;
}

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
