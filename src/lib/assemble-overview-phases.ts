/**
 * Overview-map assembly phases extracted from `assemble-overview.ts`. Each
 * function is one block of the overview pipeline: it takes the accumulators it
 * appends to plus the narrow slice of context it needs, and mutates them in
 * place, mirroring the pass style of `inference.ts`. The shared domain types
 * (module/district/infra shapes) live here so both files reference one
 * definition. Rule IDs (O8, O11) refer to HEURISTICS.md.
 */
import { dirname, relative, sep } from "node:path";
import {
    addEdge,
    barrelAwareName,
    footprintFor,
    roomLabel,
    sdkImporterIds,
    splitEdgeKey,
    uniqueId,
} from "./assembly-helpers.ts";
import type { Coupling } from "./coupling.ts";
import type { HostScanResult } from "./host-config.ts";
import { type Host, isServiceShadowed } from "./hosts.ts";
import {
    classifiedVariantServices,
    inferEmbeddedDatabaseUse,
    inferExternalDelivers,
    inferModuleDataFlows,
    isEntryPoint,
} from "./inference.ts";
import type { FileEdge, MapEdge, MapNode } from "./map-types.ts";
import type { Package } from "./packages.ts";
import { type Room, roomDir } from "./rooms.ts";
import { type EmbeddedDatabase, type ExternalServiceDep, OTLP_PATTERN } from "./scans.ts";
import { kebab, titleCase } from "./text.ts";
import type { EdgeHost } from "./wrangler.ts";

// Migration scripts (**/migrations/0001_xxx.ts) collapse to one leaf per
// migrations directory; only overview mode groups them.
const MIGRATION_FILE_PATTERN = /\/migrations\/\d+[-_.][^/]*$/;

/**
 * The mutable substrate the overview's district-band-emit phases share: the
 * node accumulator and module indexes, plus the shared helper closures the
 * orchestrator builds once (file reads, deploy-host attribution, band naming,
 * and the shared-utility test). A phase reads the slice it needs and appends to
 * `overviewNodes` (and the two module indexes) in place.
 */
export type OverviewState = {
    /** The overview nodes accumulated so far; the emit phase appends to these. */
    overviewNodes: MapNode[];
    /** Module node id -> its files, for the later flow-edge classification. */
    allModules: { id: string; files: string[] }[];
    /** Source file -> module node id, for the later flow and import edges. */
    fileToModule: Map<string, string>;
    /** Line count of a file set. */
    linesOfFiles: (files: readonly string[]) => number;
    /** Reads a repo-relative file's text. */
    fileText: (file: string) => string;
    /** The deploy hosts a file set collectively ships to (D3 COPY membership). */
    filesHosts: (files: readonly string[]) => Set<string>;
    /** A deploy host's band index. */
    hostBand: (hostName: string) => number;
    /** A band index's display label. */
    bandLabel: (band: number) => string;
    /** Whether a module's file set reads as shared plumbing (fan-in heavy). */
    moduleIsUtility: (files: readonly string[]) => boolean;
};

/** An overview module: a source file (or a collapsed group) drawn as a structure. */
type OverviewModule = {
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

/**
 * Builds the overview's districts from the room structure: one district per
 * package in a multi-package repo, else one per active room. Each district's
 * modules come from `modulesForRoom` (migration scripts collapse to one leaf
 * per migrations directory; every other file is its own module, disambiguated
 * by subdirectory when labels collide). District and module ids are then
 * deduplicated (kebab-casing can flatten distinct paths onto one id), districts
 * first so the modules' parentId picks up the deduped district id.
 *
 * @param options - `multiPkg` whether to group by package; `pkgsWithRooms` the
 *   packages holding rooms; `activeRooms` the non-empty rooms; `fileCoupling`
 *   for the per-file support classification.
 * @returns The districts with unique ids, bands still zero (assigned later).
 */
export function buildOverviewDistricts(options: {
    multiPkg: boolean;
    pkgsWithRooms: readonly Package[];
    activeRooms: readonly Room[];
    fileCoupling: ReadonlyMap<string, Coupling>;
}): OverviewDistrict[] {
    const { multiPkg, pkgsWithRooms, activeRooms, fileCoupling } = options;
    /**
     * Splits a room into overview modules: migration scripts collapse to one
     * leaf per migrations directory; every other file is its own module,
     * wherever it sits in the tree, with duplicate labels within the room
     * disambiguated by their subdirectory.
     *
     * @param room - Directory-backed room to convert.
     * @returns The room's overview modules (collapsed migrations first).
     */
    const modulesForRoom = (room: Room): OverviewModule[] => {
        const entries: OverviewModule[] = [];
        // Migration scripts (**/migrations/0001_xxx.ts) collapse to one leaf per
        // migrations directory, wherever they sit in the tree.
        const migrationFiles = room.files.filter((f) => MIGRATION_FILE_PATTERN.test(f));
        const migrationDirs = new Map<string, string[]>();
        for (const file of migrationFiles) {
            const dir = dirname(file);
            migrationDirs.set(dir, [...(migrationDirs.get(dir) ?? []), file]);
        }
        for (const [dir, files] of migrationDirs) {
            entries.push({
                id: kebab(`${room.id}-${relative(roomDir(room), dir)}`),
                label: `Migrations (${files.length})`,
                files,
                path: dir,
                support: true,
                collapsed: true,
            });
        }
        // Every remaining file is a module, wherever it sits in the tree —
        // subdirectories (src/lib/configuration, plugins/codex-otlp-traces) are
        // shown as their files, not as buildings. Duplicate names within a
        // district are disambiguated by their subdirectory.
        const rest = room.files.filter((f) => !MIGRATION_FILE_PATTERN.test(f));
        const fileEntries = rest.map((file): OverviewModule => {
            const local = relative(roomDir(room), file).replace(/\.[a-z]+$/, "");
            return {
                id: kebab(`${room.id}-${local}`),
                label: titleCase(barrelAwareName(file)),
                sublabel: local.includes(sep) ? dirname(local) : null,
                files: [file],
                path: file,
                support: (fileCoupling.get(file)?.in ?? 0) > 0,
            };
        });
        const labelCounts = new Map<string, number>();
        for (const entry of fileEntries) labelCounts.set(entry.label, (labelCounts.get(entry.label) ?? 0) + 1);
        for (const entry of fileEntries) {
            if ((labelCounts.get(entry.label) ?? 0) > 1 && entry.sublabel)
                entry.label = `${entry.label} (${entry.sublabel})`;
        }
        return [...entries, ...fileEntries];
    };

    const districts: OverviewDistrict[] = multiPkg
        ? pkgsWithRooms.map((pkg) => ({
              id: kebab(`${pkg.id}-district`),
              label: titleCase(pkg.name),
              path: pkg.dir,
              modules: activeRooms.filter((r) => r.pkg === pkg).flatMap((room) => modulesForRoom(room)),
              hosts: [],
              band: 0,
          }))
        : activeRooms.map((room) => ({
              id: kebab(`${room.id}-district`),
              label: roomLabel(room.segment),
              path: roomDir(room),
              modules: modulesForRoom(room),
              hosts: [],
              band: 0,
          }));

    // Two packages can share a name (a repo's root and a workspace package both
    // named @scope/pkg, as in ollama-code), which collides their district ids;
    // suffix later collisions so the map stays valid. Done before module ids so
    // the modules' parentId picks up the deduped district id.
    const usedDistrictIds = new Set<string>();
    for (const district of districts) {
        district.id = uniqueId(district.id, (id) => usedDistrictIds.has(id));
        usedDistrictIds.add(district.id);
    }
    // Kebab-casing can flatten distinct paths onto one id (src/local/config vs
    // src-local/config); suffix later collisions rather than emit invalid maps.
    const usedModuleIds = new Set<string>();
    for (const district of districts) {
        for (const m of district.modules) {
            m.id = uniqueId(m.id, (id) => usedModuleIds.has(id));
            usedModuleIds.add(m.id);
        }
    }
    return districts;
}

/**
 * O7 banding: assigns each district its deployment band and sorts them. A
 * district whose code ships to exactly one host sits in that host's band;
 * district code that ships nowhere but produces OTLP telemetry sits in the
 * generators band; everything else sits in the shared/support strip. Mutates
 * `districts` in place (both `hosts` and `band`), then sorts by band.
 *
 * @param districts - The districts to band, mutated in place.
 * @param state - The overview state (`filesHosts`, `hostBand`, `fileText`).
 * @param options - `producersBand`/`sharedBand` the two non-host band indexes.
 */
export function bandOverviewDistricts(
    districts: OverviewDistrict[],
    state: OverviewState,
    options: { producersBand: number; sharedBand: number },
): void {
    const { filesHosts, hostBand, fileText } = state;
    const { producersBand, sharedBand } = options;
    for (const district of districts) {
        const hostSet = filesHosts(district.modules.flatMap((m) => m.files));
        const producesOtlp = district.modules.some((m) => m.files.some((f) => OTLP_PATTERN.test(fileText(f))));
        district.hosts = [...hostSet];
        const soleHost = district.hosts[0];
        district.band =
            hostSet.size === 1 && soleHost !== undefined
                ? hostBand(soleHost)
                : hostSet.size === 0 && producesOtlp
                  ? producersBand
                  : sharedBand;
    }
    districts.sort((a, b) => a.band - b.band || a.id.localeCompare(b.id));
}

/**
 * O2/O5: emits the district and module nodes into `overviewNodes`. Each
 * district scope carries its band tag and a shared/app colour by its share of
 * utility modules; each module is a building (multi-file, non-collapsed),
 * gateway (entry point), or worker, sized by lines of code and worst-function
 * complexity, tagged support/composer with its deploy-host tags, and placed by
 * path order. Building modules also emit one room node per file. Populates
 * `state.fileToModule` and `state.allModules` for the later edge phases.
 *
 * @param districts - The banded, sorted districts to emit.
 * @param state - The overview state (`overviewNodes`/`fileToModule`/
 *   `allModules` accumulators, `linesOfFiles`, `filesHosts`, `bandLabel`,
 *   `moduleIsUtility`).
 * @param options - District/module/tsx colours; the complexity, doc, and
 *   coverage lookups; and the `scriptReferencedFiles`/`entryDirNames` entry
 *   classification inputs.
 */
export function emitOverviewModuleNodes(
    districts: readonly OverviewDistrict[],
    state: OverviewState,
    options: {
        appColor: string;
        sharedColor: string;
        tsxColor: string;
        fileMaxFunctionComplexity: (file: string) => number;
        fileComplexity: (file: string) => number;
        docForFiles: (files: readonly string[]) => string | null;
        coverageForFiles: (files: readonly string[]) => number | null;
        scriptReferencedFiles: ReadonlySet<string>;
        entryDirNames: ReadonlySet<string>;
    },
): void {
    const { overviewNodes, allModules, fileToModule, linesOfFiles, filesHosts, bandLabel, moduleIsUtility } = state;
    const {
        appColor,
        sharedColor,
        tsxColor,
        fileMaxFunctionComplexity,
        fileComplexity,
        docForFiles,
        coverageForFiles,
        scriptReferencedFiles,
        entryDirNames,
    } = options;
    for (const district of districts) {
        if (!district.modules.length) continue;
        const utilityShare = district.modules.filter((m) => moduleIsUtility(m.files)).length / district.modules.length;
        const shared = utilityShare >= 0.6;
        const color = shared ? sharedColor : appColor;
        overviewNodes.push({
            id: district.id,
            label: district.label,
            kind: "scope",
            archetype: "district",
            description: `${shared ? "Shared code" : "Function area"}: ${district.path === "." ? "repository root" : `${district.path}/`} — ${district.modules.length} module${district.modules.length === 1 ? "" : "s"}${district.hosts.length ? ` — deploys to ${district.hosts.join(", ")}` : ""}.`,
            tags: [`band:${bandLabel(district.band)}`],
            display: { color, flowLayer: district.band },
        });
        // Files in the same directory sit adjacent on the map: placement order is
        // the path, carried to the viewer as display.flowOrder.
        const placementOrder = new Map(
            [...district.modules].sort((a, b) => a.path.localeCompare(b.path)).map((m, index) => [m.id, index]),
        );
        for (const m of district.modules) {
            const moduleHostTags = [...filesHosts(m.files)].map((name) => `host:${name}`);
            const loc = linesOfFiles(m.files);
            // Complexity is the worst single function in the module: a big module
            // of simple functions should not outscore one gnarly function.
            const complexity = Math.max(...m.files.map((f) => fileMaxFunctionComplexity(f)));
            const height = Math.max(0.6, 0.55 + Math.min(loc, 1500) / 320);
            // Floor area is complexity alone: equal complexity reads as equal
            // footprint whether the module is a composer or support (the ziggurat
            // shape and height already distinguish them).
            // Ceiling 2.5: at the viewer's 80% render scale that equals the 2.0
            // layout step, so even max-complexity buildings cannot overlap.
            const footprint = footprintFor(complexity);
            const asBuilding = m.files.length >= 2 && !m.collapsed;
            // Same classification as the deployment map: entry modules are gateways
            // (entry points), everything else a worker. At file granularity the
            // entry name may be the file itself — exactly cli/cmd/main, or the
            // *-cli / *-command suffix convention (redeploy-cli.ts,
            // delivery-command.ts). Bare api.ts stays a worker: usually a
            // client/types module, not an entry.
            // A file referenced from a package.json script is a DECLARED entry,
            // whatever its name. Name-based entries (entry dirs, *-cli/*-command
            // suffixes) only qualify as composers: an imported *-command file (a
            // shared configured-command helper) is plumbing, not an entry.
            const isEntryModule = isEntryPoint({
                files: m.files,
                scriptReferencedFiles,
                nameArm: { granularity: "module", path: m.path, support: m.support, entryDirNames },
            });
            const doc = docForFiles(m.files);
            const coverage = coverageForFiles(m.files);
            overviewNodes.push({
                id: m.id,
                label: m.label,
                kind: "module",
                archetype: asBuilding ? "building" : isEntryModule ? "gateway" : "worker",
                parentId: district.id,
                // TSDoc prose only — the stats live in metrics and render in the
                // panel's Stats section.
                ...(doc ? { description: doc } : {}),
                ...(isEntryModule ? { attributes: { "entry-point": m.path } } : {}),
                sourceRefs: [{ path: m.path }],
                metrics: {
                    loc,
                    complexity,
                    files: m.files.length,
                    ...(coverage !== null ? { coverage } : {}),
                },
                tags: [m.support ? "support" : "composer", ...moduleHostTags],
                display: {
                    size: [footprint, height * (m.support ? 0.85 : 1), footprint * 0.85],
                    color: m.files.every((f) => f.endsWith(".tsx")) ? tsxColor : color,
                    flowLayer: m.support ? 1 : 0,
                    flowOrder: placementOrder.get(m.id),
                },
            });
            for (const file of m.files) fileToModule.set(file, m.id);
            allModules.push({ id: m.id, files: m.files });
            if (asBuilding) {
                for (const file of m.files) {
                    const fileLoc = linesOfFiles([file]);
                    overviewNodes.push({
                        id: kebab(`${m.id}-${relative(m.path, file).replace(/\.[a-z]+$/, "")}`),
                        label: titleCase(barrelAwareName(file)),
                        kind: "module",
                        archetype: "room",
                        parentId: m.id,
                        description: `Source file ${file}: ${fileLoc} lines, complexity ${fileComplexity(file)}.`,
                        sourceRefs: [{ path: file }],
                        metrics: { loc: fileLoc, complexity: fileComplexity(file) },
                    });
                }
            }
        }
    }
}
