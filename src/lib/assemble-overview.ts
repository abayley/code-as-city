/**
 * Overview-map assembly (--overview mode). Builds the whole-codebase module
 * overview — every source file a structure, districts by directory or
 * package, banded front-to-back by deployment role — and emits it via the
 * shared map envelope. Rule IDs (O2, O5, O7, O11, C1, D3) refer to
 * HEURISTICS.md.
 */
import { basename, dirname, join, relative, sep } from "node:path";
import {
    addEdge,
    fileModuleName,
    footprintFor,
    linesOf,
    mermaidId,
    roomLabel,
    splitEdgeKey,
    uniqueId,
} from "./assembly-helpers.ts";
import type { Coupling } from "./coupling.ts";
import { emitMap } from "./emit.ts";
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
import { readText } from "./read.ts";
import { type Room, roomDir } from "./rooms.ts";
import type { EmbeddedDatabase } from "./scans.ts";
import { OTLP_PATTERN } from "./scans.ts";
import { kebab, titleCase } from "./text.ts";
import type { EdgeHost } from "./wrangler.ts";

// Migration scripts (**/migrations/0001_xxx.ts) collapse to one leaf per
// migrations directory; only overview mode groups them.
const MIGRATION_FILE_PATTERN = /\/migrations\/\d+[-_.][^/]*$/;

// A module: { id, label, files, path, support, collapsed }
type OverviewModule = {
    id: string;
    label: string;
    sublabel?: string | null | undefined;
    files: string[];
    path: string;
    support: boolean;
    collapsed?: boolean | undefined;
};

type OverviewDistrict = {
    id: string;
    label: string;
    path: string;
    modules: OverviewModule[];
    // Assigned by the banding pass before any read.
    hosts: string[];
    band: number;
};

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

type InfraDistrict = { id: string; label: string; band: number; members: InfraMember[] };

export type OverviewContext = {
    repo: string;
    outDir: string;
    rooms: Map<string, Room>;
    hosts: readonly Host[];
    candidateHosts: readonly Host[];
    hostScan: readonly HostScanResult[];
    serviceOwner: ReadonlyMap<string, string>;
    hostLayer: Map<string, number>;
    edgeHost: EdgeHost | null;
    drizzleConfig: string | undefined;
    embeddedDatabases: readonly EmbeddedDatabase[];
    fileEdges: readonly FileEdge[];
    fileCoupling: Map<string, Coupling>;
    fileComplexity: (file: string) => number;
    fileMaxFunctionComplexity: (file: string) => number;
    scriptReferencedFiles: ReadonlySet<string>;
    coverageForFiles: (files: readonly string[]) => number | null;
    docForFiles: (files: readonly string[]) => string | null;
    devToolingWarnings: readonly string[];
    entryDirNames: ReadonlySet<string>;
    dbWritePattern: RegExp;
    dbReadPattern: RegExp;
};

/**
 * Overview mode (--overview): a whole-codebase module overview. Districts are
 * directories (or packages in a multi-package repo), every module is a
 * structure, no edges at rest. Composer modules (fan-in 0: CLIs, entries)
 * stand in the front row; supporting modules sit behind, smaller, tagged
 * "support". Migrations collapse to one leaf. Deployment infra and
 * config-declared externals get one district. Height scales with lines of
 * code (unclamped above the minimum); footprint scales with a
 * cyclomatic-complexity approximation (decision-point count).
 * Writes map.json and map.md into outDir.
 *
 * @param context - Everything the overview reads: the repository path and
 *   output directory, the room structure, the resolved deployment shape
 *   (hosts, compose variants, wrangler edge host, drizzle and embedded
 *   databases), the file import graph and coupling, the metric and
 *   documentation lookups, and the entry-dir names and database read/write
 *   patterns used for classification.
 * @returns Resolves once map.json and map.md have been written.
 */
export async function runOverview(context: OverviewContext): Promise<void> {
    const {
        repo,
        outDir,
        rooms,
        hosts,
        candidateHosts,
        hostScan,
        serviceOwner,
        hostLayer,
        edgeHost,
        drizzleConfig,
        embeddedDatabases,
        fileEdges,
        fileCoupling,
        fileComplexity,
        fileMaxFunctionComplexity,
        scriptReferencedFiles,
        coverageForFiles,
        docForFiles,
        devToolingWarnings,
        entryDirNames,
        dbWritePattern,
        dbReadPattern,
    } = context;
    // District/module colours baked into map.json; keep in step with the
    // viewer's colour vocabulary in viewer/lib/palette.ts.
    const OVERVIEW_APP_COLOR = "#C77740";
    const OVERVIEW_SHARED_COLOR = "#C79F40";
    const OVERVIEW_INFRA_COLOR = "#283B47";
    // .tsx (UI component) modules stand out from plain .ts. Shares the
    // shared-code gold by decision.
    const OVERVIEW_TSX_COLOR = "#C79F40";
    /**
     * Reads a source file's text for pattern scans and inference passes.
     *
     * @param file - Repository-relative path of the file to read.
     * @returns The file's contents.
     */
    const fileText = (file: string) => readText(join(repo, file));
    const activeRooms = [...rooms.values()].filter((r) => r.files.length > 0);
    const pkgsWithRooms = [...new Set(activeRooms.map((r) => r.pkg))];
    const multiPkg = pkgsWithRooms.length > 1;

    // Deploy-host attribution: which hosts does a file ship to (via D3 COPY
    // membership of services built from this repo)?
    const copyDirHosts = new Map<string, Set<string>>(); // dir -> Set(host name)
    for (const host of hosts) {
        for (const service of host.services) {
            if (!service.dockerfile) continue;
            for (const copy of service.copies) {
                const dir = copy.replace(/\/$/, "");
                // A COPY of a whole dominant source root (the dashboard image copying
                // bare `src` for its client bundle) is a packaging convenience, not
                // module attribution: skip dirs coarser than the room granularity.
                if (activeRooms.some((room) => roomDir(room).startsWith(`${dir}/`))) continue;
                let dirHosts = copyDirHosts.get(dir);
                if (!dirHosts) {
                    dirHosts = new Set();
                    copyDirHosts.set(dir, dirHosts);
                }
                dirHosts.add(host.name);
            }
        }
    }
    /**
     * Names the deploy hosts a single file ships to, via D3 COPY-directory
     * membership.
     *
     * @param file - Repository-relative source file to attribute.
     * @returns The set of host names whose service images copy the file in.
     */
    const fileHosts = (file: string) => {
        const result = new Set<string>();
        for (const [dir, hostNames] of copyDirHosts) {
            if (file === dir || file.startsWith(`${dir}/`)) for (const name of hostNames) result.add(name);
        }
        return result;
    };
    /**
     * Names the deploy hosts a set of files collectively ships to (the union
     * of fileHosts over the set).
     *
     * @param files - Repository-relative source files, typically a module's
     *   or district's file set.
     * @returns The set of host names any of the files deploy to.
     */
    const filesHosts = (files: readonly string[]) => {
        const result = new Set<string>();
        for (const file of files) for (const name of fileHosts(file)) result.add(name);
        return result;
    };

    // Band order: shared/support strip in front (band 0), then generators,
    // then the host chain, externals behind the last host.
    const SHARED_BAND = 0;
    const PRODUCERS_BAND = 1;
    /**
     * Maps a host to its front-to-back band, after the shared strip and the
     * generators band, in declared forwarding-chain order.
     *
     * @param name - Host name from the deployment shape.
     * @returns The band index for districts deploying to that host.
     */
    const hostBand = (name: string) => 2 + (hostLayer.get(name) ?? 0);
    const maxHostBand = 2 + Math.max(0, ...hostLayer.values());
    const EXTERNALS_BAND = maxHostBand + 1;
    const hostNameForBand = new Map([...hostLayer.entries()].map(([name, layer]) => [2 + layer, name]));
    /**
     * Human-readable name for a band, used in the band: tags on districts.
     *
     * @param band - Band index (shared strip, generators, a host's band, or
     *   the externals band).
     * @returns The band's display label.
     */
    const bandLabel = (band: number) => {
        if (band === SHARED_BAND) return "Shared & support";
        if (band === PRODUCERS_BAND) return "Generators";
        if (band === EXTERNALS_BAND) return "External systems";
        const hostName = hostNameForBand.get(band);
        return hostName !== undefined ? `${titleCase(hostName)} host` : `Strip ${band}`;
    };

    // These stay local rather than reading the C1 fileCoupling in context: they
    // count EDGES crossing the module's file-set boundary, while
    // couplingFromEdges counts DISTINCT neighbours (Sets) and includes
    // self-edges; multi-file modules (collapsed migrations) also aggregate over
    // a file-set that has no per-module entry in fileCoupling. Not equivalent.
    /**
     * Counts import edges arriving from outside a module's file set.
     *
     * @param files - The module's source files.
     * @returns Number of file-level import edges into the set from files
     *   outside it.
     */
    const externalFanIn = (files: readonly string[]) => {
        const set = new Set(files);
        return fileEdges.filter(({ from, to }) => set.has(to) && !set.has(from)).length;
    };
    /**
     * Counts import edges leaving a module's file set.
     *
     * @param files - The module's source files.
     * @returns Number of file-level import edges from the set to files
     *   outside it.
     */
    const externalFanOut = (files: readonly string[]) => {
        const set = new Set(files);
        return fileEdges.filter(({ from, to }) => set.has(from) && !set.has(to)).length;
    };
    /**
     * Classifies a module as shared utility code: fan-in of at least two and
     * instability (fan-out share) at most 0.33 — many importers, few imports.
     * Feeds the shared-code district colouring.
     *
     * @param files - The module's source files.
     * @returns True when the module reads as shared plumbing.
     */
    const moduleIsUtility = (files: readonly string[]) => {
        const fanIn = externalFanIn(files);
        const fanOut = externalFanOut(files);
        return fanIn >= 2 && fanOut / (fanIn + fanOut) <= 0.33;
    };
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
                label: titleCase(basename(local)),
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

    // Kebab-casing can flatten distinct paths onto one id (src/local/config vs
    // src-local/config); suffix later collisions rather than emit invalid maps.
    const usedModuleIds = new Set<string>();
    for (const district of districts) {
        for (const m of district.modules) {
            m.id = uniqueId(m.id, (id) => usedModuleIds.has(id));
            usedModuleIds.add(m.id);
        }
    }

    const overviewNodes: MapNode[] = [];
    const allModules: { id: string; files: string[] }[] = []; // for flow-edge classification
    const fileToModule = new Map<string, string>(); // source file -> module node id (for flow edges)

    // Band per district: single-host code sits in its host's band, OTLP
    // producers in the front band, everything shared or unplaced in the strip.
    for (const district of districts) {
        const hostSet = filesHosts(district.modules.flatMap((m) => m.files));
        const producesOtlp = district.modules.some((m) =>
            m.files.some((f) => OTLP_PATTERN.test(readText(join(repo, f)))),
        );
        district.hosts = [...hostSet];
        const soleHost = district.hosts[0];
        district.band =
            hostSet.size === 1 && soleHost !== undefined
                ? hostBand(soleHost)
                : hostSet.size === 0 && producesOtlp
                  ? PRODUCERS_BAND
                  : SHARED_BAND;
    }
    districts.sort((a, b) => a.band - b.band || a.id.localeCompare(b.id));

    for (const district of districts) {
        if (!district.modules.length) continue;
        const utilityShare = district.modules.filter((m) => moduleIsUtility(m.files)).length / district.modules.length;
        const shared = utilityShare >= 0.6;
        const color = shared ? OVERVIEW_SHARED_COLOR : OVERVIEW_APP_COLOR;
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
            const loc = linesOf(repo, m.files);
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
                    color: m.files.every((f) => f.endsWith(".tsx")) ? OVERVIEW_TSX_COLOR : color,
                    flowLayer: m.support ? 1 : 0,
                    flowOrder: placementOrder.get(m.id),
                },
            });
            for (const file of m.files) fileToModule.set(file, m.id);
            allModules.push({ id: m.id, files: m.files });
            if (asBuilding) {
                for (const file of m.files) {
                    const fileLoc = linesOf(repo, [file]);
                    overviewNodes.push({
                        id: kebab(`${m.id}-${relative(m.path, file).replace(/\.[a-z]+$/, "")}`),
                        label: titleCase(fileModuleName(file)),
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

    // Infrastructure & external systems: image-only compose services (databases,
    // collectors), config-declared external receivers, wrangler, drizzle.
    const infraMembers: InfraMember[] = [];
    const overviewEdges: MapEdge[] = [];
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
                band: m.external ? EXTERNALS_BAND : m.hostName ? hostBand(m.hostName) : SHARED_BAND,
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
            display: { color: OVERVIEW_INFRA_COLOR, flowLayer: infraDistrict.band },
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
                display: { color: OVERVIEW_INFRA_COLOR },
            });
        }
    }

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

    // Import edges, aggregated per module pair. The viewer never draws these
    // at rest — they appear only when a node is selected — so they cost map
    // size, not visual noise.
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

    await emitMap({
        repo,
        outDir,
        nodes: overviewNodes,
        edges: overviewEdges,
        warnings: [
            "Overview mode: orphan exclusion is intentionally skipped; QA-only dev tooling is stripped as in the deployment map.",
            ...devToolingWarnings,
            "Only data-flow edges are shown; import dependencies are omitted by design.",
            "Shared-code districts (>=60% high fan-in / low fan-out modules) are coloured differently.",
            "Complexity is the module's worst single function (McCabe-style decision-point count), not a module-wide sum.",
        ],
        idSuffix: "-overview",
        nameSuffix: " overview",
        summary: "Module overview: every module as a structure, grouped by directory; no dependency edges.",
        /**
         * Renders map.md's body: one mermaid subgraph per district, each
         * module a labelled node with its loc/complexity and source path.
         *
         * @param map - The swept map envelope being emitted.
         * @returns The markdown document body.
         */
        mermaidBody: (map) =>
            [
                `# ${map.name}`,
                "",
                "```mermaid",
                "flowchart TB",
                ...overviewNodes
                    .filter((n) => n.kind === "scope")
                    .flatMap((scope) => [
                        `  subgraph ${mermaidId(scope.id)}["${scope.label}${(scope.description ?? "").startsWith("Shared") ? " (shared code)" : ""}"]`,
                        ...overviewNodes
                            .filter((n) => n.parentId === scope.id)
                            .map(
                                (n) =>
                                    `    ${mermaidId(n.id)}["${n.label}<br/><i>${n.metrics ? `${n.metrics.loc} loc, cx ${n.metrics.complexity}` : n.archetype}</i><br/>${(n.sourceRefs?.[0]?.path ?? "").replace(/"/g, "'")}"]`,
                            ),
                        "  end",
                    ]),
                "```",
            ].join("\n"),
        consoleLines: () => [
            `Wrote ${outDir}/map.json + map.md (overview mode)`,
            `districts=${districts.length + (uniqueInfra.length ? 1 : 0)} nodes=${overviewNodes.length}`,
        ],
    });
}
