/**
 * Deployment-map assembly (section 7 of the generator). Turns the deployment
 * shape (compose hosts, wrangler edge config, CI workflows), the room/package
 * structure, and the import graph into the city map's nodes, edges, and
 * warnings. D9-D12, C2 and the O-series parallels are HEURISTICS.md rule
 * IDs; the 7a-7f markers are this file's own section headings, inherited
 * from section 7 of the pre-extraction generator, and are not in the rule
 * catalogue.
 */
import { basename, join, relative, sep } from "node:path";
import {
    addEdge,
    escapeRegex,
    fileModuleName,
    footprintFor,
    linesOf,
    roomLabel,
    sdkImporterIds,
    splitEdgeKey,
    uniqueId,
} from "./assembly-helpers.ts";
import { COUPLING_THRESHOLDS, type Coupling, type CouplingAnalysis } from "./coupling.ts";
import type { SpawnedEntry } from "./daemons.ts";
import { layerByLongestPath } from "./flow.ts";
import type { HostScanResult } from "./host-config.ts";
import { type Host, isServiceShadowed } from "./hosts.ts";
import {
    classifiedVariantServices,
    inferEmbeddedDatabaseUse,
    inferExternalDelivers,
    inferModuleDataFlows,
    isEntryPoint,
    type NodeIndexEntry,
} from "./inference.ts";
import type { FileEdge, MapEdge, MapNode, SourceRef } from "./map-types.ts";
import { artefactEntryCandidates, owningPackage as owningPackageOf, type Package } from "./packages.ts";
import type { PathReassignment } from "./path-references.ts";
import { readJson, readText } from "./read.ts";
import { type Room, roomDir } from "./rooms.ts";
import type { RunnableApp } from "./runnable.ts";
import { type EmbeddedDatabase, type ExternalServiceDep, OTLP_PATTERN } from "./scans.ts";
import { kebab, titleCase } from "./text.ts";
import type { CiWorkflow } from "./workflows.ts";
import type { EdgeHost } from "./wrangler.ts";

type ResolvedImport = { file: string } | { pkg: Package } | { bare: string };

export type DeploymentContext = {
    repo: string;
    modulesAsBuildings: boolean;
    allFiles: readonly string[];
    sourceFiles: readonly string[];
    packages: readonly Package[];
    rooms: Map<string, Room>;
    fileToRoom: Map<string, Room>;
    resolveImport: (fromFile: string, specifier: string) => ResolvedImport | null;
    fileEdges: readonly FileEdge[];
    packageEdges: ReadonlyMap<string, boolean>;
    roomEdges: ReadonlyMap<string, number>;
    fileCoupling: Map<string, Coupling>;
    roomCoupling: Map<string, Coupling>;
    isUtilityRoom: (roomId: string) => boolean;
    eliminatedRooms: CouplingAnalysis["eliminatedRooms"];
    hosts: readonly Host[];
    candidateHosts: readonly Host[];
    hostScan: readonly HostScanResult[];
    serviceDependsOn: ReadonlyMap<string, Set<string>>;
    serviceOwner: ReadonlyMap<string, string>;
    hostLayer: Map<string, number>;
    edgeHost: EdgeHost | null;
    drizzleConfig: string | undefined;
    embeddedDatabases: readonly EmbeddedDatabase[];
    externalServiceDeps: readonly ExternalServiceDep[];
    ciWorkflows: readonly CiWorkflow[];
    coverageForFiles: (files: readonly string[]) => number | null;
    fileDocSummary: (file: string) => string | null;
    docForFiles: (files: readonly string[]) => string | null;
    fileMaxFunctionComplexity: (file: string) => number;
    deployReachable: ReadonlySet<string>;
    hostDeployReachable: ReadonlySet<string>;
    hasHostDeployShape: boolean;
    scriptReachable: ReadonlySet<string>;
    spawnedEntries: readonly SpawnedEntry[];
    runnableApps: readonly RunnableApp[];
    scriptReferencedFiles: ReadonlySet<string>;
    devToolingWarnings: readonly string[];
    pathReassignments: Map<string, PathReassignment>;
    entryDirNames: ReadonlySet<string>;
    dbWritePattern: RegExp;
    dbReadPattern: RegExp;
};

export type AssembledMap = {
    nodes: MapNode[];
    edges: MapEdge[];
    warnings: string[];
};

// 7a. Host districts carry explicit flow layers from the declared forwarding
// chain with a large base, so they always sit behind the code districts.
const HOST_LAYER_BASE = 1000;
// Externals are their own systems, not tenants of whichever host's config
// mentions them: they share one district behind the host chain (as overview
// mode's O7 does).
const EXTERNALS_DISTRICT_ID = "external-systems";

// 7f. Static I/O classification patterns (declared boundary roles).
const LISTEN_PATTERN = /Bun\.serve|\.listen\s*\(|createServer\s*\(|@fastify|express\s*\(\)/;
const HTTP_CLIENT_PATTERN = /\bfetch\s*\(|axios[.(]|new\s+Request\s*\(/;

/**
 * Section 7 of the generator: assembles the deployment map's nodes, edges,
 * and warnings from the deployment shape, room structure, import graph, CI
 * workflows, and static I/O classification.
 *
 * @param context - Everything the assembly reads: the repository path and file
 *   inventory, the room/package structure and coupling analysis, the resolved
 *   deployment shape (hosts, compose variants, wrangler edge host, drizzle and
 *   embedded databases, CI workflows), reachability sets, and the metric and
 *   documentation lookups used to size and describe nodes.
 * @returns The assembled deployment map: its nodes, edges, and the warnings
 *   accumulated while applying the mapping rules.
 */
export function assembleDeployment(context: DeploymentContext): AssembledMap {
    const {
        repo,
        modulesAsBuildings,
        allFiles,
        sourceFiles,
        packages,
        rooms,
        fileToRoom,
        resolveImport,
        fileEdges,
        packageEdges,
        roomEdges,
        fileCoupling,
        roomCoupling,
        isUtilityRoom,
        eliminatedRooms,
        hosts,
        candidateHosts,
        hostScan,
        serviceDependsOn,
        serviceOwner,
        hostLayer,
        edgeHost,
        drizzleConfig,
        embeddedDatabases,
        externalServiceDeps,
        ciWorkflows,
        coverageForFiles,
        fileDocSummary,
        docForFiles,
        fileMaxFunctionComplexity,
        deployReachable,
        hostDeployReachable,
        hasHostDeployShape,
        scriptReachable,
        scriptReferencedFiles,
        spawnedEntries,
        runnableApps,
        devToolingWarnings,
        pathReassignments,
        entryDirNames,
        dbWritePattern,
        dbReadPattern,
    } = context;

    /**
     * Tests whether a repository-relative path is part of the scanned file
     * inventory.
     *
     * @param p - Repository-relative path to look up.
     * @returns True when the path was found by the file scan.
     */
    const fileExists = (p: string) => allFiles.includes(p);
    /**
     * Reads a source file's text for pattern scans and inference passes.
     *
     * @param file - Repository-relative path of the file to read.
     * @returns The file's contents.
     */
    const fileText = (file: string) => readText(join(repo, file));
    /**
     * Finds which package a file or directory belongs to.
     *
     * @param file - Repository-relative path to attribute.
     * @returns The owning package, or null when no package claims the path.
     */
    const owningPackage = (file: string): Package | null => owningPackageOf(packages, file);

    // D16: the directories of packages run directly, for the R5 spare and the
    // D14 precedence check.
    const runnableByDir = new Map(runnableApps.map((app) => [app.pkgDir, app]));

    const nodes: MapNode[] = [];
    const edges: MapEdge[] = [];
    const warnings: string[] = [
        "Generated by the deterministic prototype: names and descriptions are mechanical, not semantic.",
        "Test directories and *.test/*.spec files are excluded.",
        `Shared utility modules (fan-in >= ${COUPLING_THRESHOLDS.utilityMinFanIn}, instability <= ${COUPLING_THRESHOLDS.utilityMaxInstability}) are eliminated: ${eliminatedRooms.map((r) => r.segment).join(", ") || "none"}.`,
        ...devToolingWarnings,
    ];
    const claimedSegments = new Set<string>(); // source dirs claimed by a deployed service
    const serviceClaimedDirs = new Set<string>(); // subset claimed by compose services (not wrangler)
    // campus node id -> the source files it runs (for I/O classification)
    const campusFileSets: { id: string; files: string[]; entryFile?: string | null | undefined }[] = [];
    const fileNodeOwner = new Map<string, string>(); // source file -> emitted campus node id (for shared-lib edges)

    // Experimental (--modules-as-buildings): every module node with >=2 files
    // becomes a building whose rooms are its files — a preview of "buildings
    // depict modules" while the room semantics are still undecided.
    /**
     * Allocates a node id that is free in both the emitted-node set and the
     * room-id namespace still to be emitted. Kebab-flattened ids can collide
     * across mechanisms (the file src/node.ts and the room src/node/ both
     * yield ...-src-node): suffixes until free.
     *
     * @param base - Preferred kebab-cased id.
     * @returns The base id, or the base with a numeric suffix when taken.
     */
    function uniqueNodeId(base: string): string {
        return uniqueId(base, (id) => rooms.has(id) || nodes.some((x) => x.id === id));
    }

    /**
     * Emits one room node per source file inside a building (the experimental
     * --modules-as-buildings interior view).
     *
     * @param parentId - Node id of the building the rooms belong to.
     * @param files - Repository-relative source files to render as rooms.
     */
    function pushFileRooms(parentId: string, files: readonly string[]): void {
        for (const file of files) {
            const name = fileModuleName(file);
            nodes.push({
                id: uniqueNodeId(kebab(`${parentId}-${name}`)),
                label: titleCase(name),
                kind: "module",
                archetype: "room",
                parentId,
                description: `Source file ${file}.`,
                sourceRefs: [{ path: file }],
            });
        }
    }

    /**
     * Creates the shared "External systems" district on first use (externals
     * share one district behind the host chain, as overview mode's O7 does).
     *
     * @returns The externals district's node id.
     */
    const ensureExternalsDistrict = () => {
        if (!nodes.some((n) => n.id === EXTERNALS_DISTRICT_ID)) {
            nodes.push({
                id: EXTERNALS_DISTRICT_ID,
                label: "External systems",
                kind: "scope",
                archetype: "district",
                description: "Externally hosted systems this deployment exchanges data with.",
                display: { flowLayer: HOST_LAYER_BASE + 500 },
            });
        }
        return EXTERNALS_DISTRICT_ID;
    };

    // D1: a service that a canonical topology file owns is drawn only under
    // its owner; the same name in another topology file of the directory is
    // shadowed (folded to the owner's single node), so supabase's six `Db`
    // nodes become one.
    const isShadowed = (host: Host, serviceName: string): boolean => isServiceShadowed(serviceOwner, host, serviceName);

    // 7a. Host districts from deployment shape. Hosts carry explicit flow
    // layers from the declared forwarding chain (gateway before stack before
    // evaluation), so edge cycles (evaluation <-> bootstrap) cannot scramble
    // their order.
    for (const host of hosts) {
        nodes.push({
            id: host.id,
            label: `${titleCase(host.name)} host`,
            kind: "scope",
            archetype: "district",
            description: `Deployment host projected from ${host.file}.`,
            display: { flowLayer: HOST_LAYER_BASE + (hostLayer.get(host.name) ?? 0) },
        });
        for (const service of host.services) {
            if (isShadowed(host, service.name)) continue;
            const serviceId = kebab(`${host.id}-${service.name}`);
            const allCopiedSegments = service.copies
                .map((copy) => copy.replace(/\/$/, ""))
                .filter((copy) => copy.includes("/") || rooms.has(`${owningPackage(copy)?.id}-${kebab(copy)}`))
                // A COPY only attributes source when it names a directory that
                // actually holds source: immich's layer-cache `COPY
                // ./server/package.json` names a manifest with no source under
                // it, and claiming it would flip the whole package to the
                // residual path and explode it into per-directory districts.
                // Reachability still counts the raw COPY, so R5 sees the package
                // as host-deployed.
                .filter((copy) => sourceFiles.some((f) => f.startsWith(`${copy}/`)));
            // Coupling filter: drop shared lib-like dirs (high fan-in, low fan-out).
            /**
             * Resolves a COPY'd source directory to its room id by sampling a
             * file inside it.
             *
             * @param copy - Source directory named by a Dockerfile COPY.
             * @returns The room id owning that directory; null when no
             *   source file lives under it, or undefined when the sampled
             *   file belongs to no room.
             */
            const roomIdForCopy = (copy: string) => {
                const sample = sourceFiles.find((f) => f.startsWith(`${copy}/`));
                return sample ? fileToRoom.get(sample)?.id : null;
            };
            const copiedSegments = allCopiedSegments.filter((copy) => {
                if (basename(copy) === "lib") return false; // shared plumbing, not shape
                const roomId = roomIdForCopy(copy);
                return !(roomId && isUtilityRoom(roomId));
            });
            for (const copy of allCopiedSegments) {
                claimedSegments.add(copy);
                serviceClaimedDirs.add(copy);
            }
            const serviceSourceFiles: string[] = [];
            for (const copy of copiedSegments) {
                for (const f of sourceFiles)
                    if (f.startsWith(`${copy}/`)) {
                        fileNodeOwner.set(f, serviceId);
                        serviceSourceFiles.push(f);
                    }
            }
            campusFileSets.push({ id: serviceId, files: serviceSourceFiles, entryFile: service.entryFile });
            const isScheduled = Boolean(service.schedule);
            const roomsForService = copiedSegments.length >= 2;
            const archetype = roomsForService
                ? "building"
                : (service.imageClass ?? (isScheduled ? "worker" : service.hasPorts ? "gateway" : "worker"));
            const flowLayer =
                service.imageClass === "database" || service.imageClass === "queue" || service.imageClass === "storage"
                    ? 2
                    : service.hasPorts && !service.dockerfile
                      ? 0
                      : 1;
            // A service whose entrypoint is a *-command file is labelled by that
            // command (Delivery Command, not the compose service name delivery-worker).
            const entryName = service.entryFile ? fileModuleName(service.entryFile) : null;
            nodes.push({
                id: serviceId,
                label: titleCase(entryName?.endsWith("-command") ? entryName : service.name),
                kind: service.dockerfile ? "deployable" : "infra",
                archetype,
                parentId: host.id,
                // Prose (TSDoc, prepended in 7f) plus the schedule as its own
                // paragraph; build/entry provenance moves to labelled attributes
                // rendered in the Source files section.
                description: [
                    service.dockerfile ? null : `Container image ${service.image ?? "unknown"}.`,
                    service.schedule ? `Scheduled job: ${service.schedule}` : null,
                ]
                    .filter(Boolean)
                    .join("\n\n"),
                attributes: {
                    ...(service.dockerfile ? { "service-source": service.dockerfile } : {}),
                    ...(service.entryFile ? { "entry-point": service.entryFile } : {}),
                },
                sourceRefs: [{ path: service.dockerfile ?? host.file }],
                ...(serviceSourceFiles.length ? { metrics: { loc: linesOf(repo, serviceSourceFiles) } } : {}),
                tags: [isScheduled ? "cron" : null, service.hasPorts ? "listens" : null].filter(
                    (tag): tag is string => tag !== null,
                ),
                display: { flowLayer },
            });
            // Rooms: one per source directory the image copies in.
            if (roomsForService) {
                const roomIds: string[] = [];
                const localEdges = new Map<string, boolean>();
                for (const copy of copiedSegments) {
                    const roomId = kebab(`${serviceId}-${copy}`);
                    roomIds.push(roomId);
                    const loc = sourceFiles.filter((f) => f.startsWith(`${copy}/`)).length;
                    nodes.push({
                        id: roomId,
                        label: titleCase(basename(copy)),
                        kind: "module",
                        archetype: "room",
                        parentId: serviceId,
                        description: `Source copied from ${copy}/ into the ${service.name} image.`,
                        sourceRefs: [{ path: copy }],
                        metrics: { loc },
                    });
                }
                // Local flow: entry dir first, then longest path over dir-level imports.
                for (const { from, to } of fileEdges) {
                    const a = copiedSegments.find((c) => from.startsWith(`${c}/`));
                    const b = copiedSegments.find((c) => to.startsWith(`${c}/`));
                    if (a && b && a !== b)
                        localEdges.set(`${kebab(`${serviceId}-${a}`)}->${kebab(`${serviceId}-${b}`)}`, true);
                }
                const serviceEntryFile = service.entryFile;
                const entryDir = serviceEntryFile
                    ? copiedSegments.find((c) => serviceEntryFile.startsWith(`${c}/`))
                    : null;
                const layers = layerByLongestPath(
                    roomIds,
                    localEdges,
                    entryDir ? [kebab(`${serviceId}-${entryDir}`)] : [],
                );
                for (const roomId of roomIds) {
                    const roomNode = nodes.find((n) => n.id === roomId);
                    if (!roomNode) throw new Error(`Service room node missing: ${roomId}`);
                    roomNode.display = { flowLayer: layers.get(roomId) ?? 0 };
                }
                for (const key of localEdges.keys()) {
                    const [from, to] = splitEdgeKey(key);
                    addEdge(edges, { id: `${from}--${to}`, from, to, kind: "depends_on", evidence: "declared" });
                }
            }
        }
    }

    // 7a-ii. Service wiring from depends_on (harvested across compose variants).
    // A dependency that only exists in a deduped variant (e.g. the development
    // compose runs the database locally) is carried onto the surviving host as
    // infra when its image classifies as one.
    const variantServices = new Map<string, Host["services"][number]>();
    for (const { service } of classifiedVariantServices(candidateHosts)) {
        if (!variantServices.has(service.name)) variantServices.set(service.name, service);
    }
    for (const host of hosts) {
        for (const service of host.services) {
            const deps = serviceDependsOn.get(service.name);
            if (!deps) continue;
            const fromId = kebab(`${host.id}-${service.name}`);
            if (!nodes.some((n) => n.id === fromId)) continue;
            for (const dep of deps) {
                // D1: a dependency owned by another topology's canonical file is
                // not re-materialised here — it lives as the owner's single node.
                if (isShadowed(host, dep)) continue;
                const toId = kebab(`${host.id}-${dep}`);
                if (!nodes.some((n) => n.id === toId)) {
                    const variant = variantServices.get(dep);
                    if (!variant) continue;
                    const variantArchetype = variant.imageClass;
                    if (variantArchetype === undefined) throw new Error(`Variant without imageClass: ${dep}`);
                    nodes.push({
                        id: toId,
                        label: titleCase(dep),
                        kind: "infra",
                        archetype: variantArchetype,
                        parentId: host.id,
                        description: `Backing service${variant.image !== undefined ? ` (image ${variant.image})` : ""} declared in a compose variant; the deployed host provides it via configuration.`,
                        sourceRefs: [{ path: host.file }],
                        display: { flowLayer: 2 },
                    });
                }
                addEdge(edges, {
                    id: `${fromId}--${toId}`,
                    from: fromId,
                    to: toId,
                    kind: "depends_on",
                    evidence: "declared",
                    label: "compose depends_on",
                });
            }
        }
    }

    // D1: a host whose every service was folded into another topology's owner
    // (e.g. a pg15-only override) has no node of its own left — drop the empty
    // district so consolidation does not leave a bare host box.
    for (const host of hosts) {
        if (!nodes.some((n) => n.parentId === host.id)) {
            const index = nodes.findIndex((n) => n.id === host.id);
            if (index !== -1) nodes.splice(index, 1);
        }
    }

    // 7a-iii. Host forwarding: a host's own config file declaring an exporter
    // endpoint that names another host (e.g. the collector gateway's
    // STACK_OTLP_ENDPOINT) links the two hosts' primary services with data_flow.
    /**
     * Picks the service node that represents a host in host-to-host wiring:
     * the collector/gateway/ingest-named service when one exists, else the
     * first service.
     *
     * @param host - Deployment host whose representative service is wanted.
     * @returns The primary service's node id, or null for a host with no
     *   services.
     */
    function primaryServiceId(host: Host): string | null {
        const preferred = host.services.find((s) => /collector|gateway|ingest/.test(s.name)) ?? host.services[0];
        return preferred ? kebab(`${host.id}-${preferred.name}`) : null;
    }
    for (const scan of hostScan) {
        const host = scan.host;
        const from = primaryServiceId(host);
        if (!from || !nodes.some((n) => n.id === from)) continue;
        for (const config of scan.configs) {
            for (const other of hosts) {
                if (other === host) continue;
                // Host-name match (the gateway's STACK_OTLP_ENDPOINT names the stack).
                if (scan.hostTargetMatches.some((m) => m.otherHost === other.name && m.config === config)) {
                    const to = primaryServiceId(other);
                    if (to && nodes.some((n) => n.id === to)) {
                        addEdge(edges, {
                            id: `${from}--${to}`,
                            from,
                            to,
                            kind: "data_flow",
                            evidence: "declared",
                            label: "OTLP forward",
                            sourceRefs: [{ path: config }],
                        });
                    }
                }
                // Service-name match (the stack's SPAN_INGEST_BEARER_TOKEN names the
                // span-ingest service on the evaluation host).
                for (const target of scan.serviceTargets) {
                    if (target.otherHost !== other.name || target.config !== config) continue;
                    const to = kebab(`${other.id}-${target.service.name}`);
                    if (nodes.some((n) => n.id === to)) {
                        addEdge(edges, {
                            id: `${from}--${to}`,
                            from,
                            to,
                            kind: "data_flow",
                            evidence: "declared",
                            label: "OTLP forward",
                            sourceRefs: [{ path: config }],
                        });
                    }
                }
            }
            // Exporter endpoints whose env token names nothing internal are external
            // systems: LANGFUSE_OTLP_ENDPOINT -> a Langfuse external node.
            for (const external of scan.externals) {
                if (external.config !== config) continue;
                const externalId = kebab(external.candidate);
                if (!nodes.some((n) => n.id === externalId)) {
                    nodes.push({
                        id: externalId,
                        label: titleCase(external.candidate),
                        kind: "external",
                        archetype: "cloud",
                        parentId: ensureExternalsDistrict(),
                        description: `External receiver declared by the ${host.name} host's exporter configuration (${external.envToken}).`,
                        sourceRefs: [{ path: config }],
                        display: { flowLayer: 4 },
                    });
                }
                addEdge(edges, {
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
    }

    // 7b. Cloudflare edge district.
    if (edgeHost) {
        const districtId = "edge-delivery";
        nodes.push({
            id: districtId,
            label: "Cloudflare edge",
            kind: "scope",
            archetype: "district",
            description: `Edge deployment declared in ${edgeHost.file}.`,
        });
        nodes.push({
            id: "edge-worker",
            label: titleCase(edgeHost.name),
            kind: "deployable",
            archetype: "worker",
            parentId: districtId,
            description: `Cloudflare Worker${edgeHost.main ? ` with entry point ${edgeHost.main}` : ""}.`,
            sourceRefs: [{ path: edgeHost.main ?? edgeHost.file }],
            display: { flowLayer: 0 },
        });
        if (edgeHost.main) {
            const mainRoot = edgeHost.main.split("/")[0];
            if (mainRoot === undefined) throw new Error(`Empty worker entry path: ${edgeHost.main}`);
            claimedSegments.add(mainRoot);
        }
        for (const binding of edgeHost.d1) {
            const d1Binding = binding as { database_name?: string | undefined; binding: string };
            const id = kebab(`d1-${d1Binding.database_name ?? d1Binding.binding}`);
            nodes.push({
                id,
                label: d1Binding.database_name ?? d1Binding.binding,
                kind: "infra",
                archetype: "database",
                parentId: districtId,
                sourceRefs: [{ path: edgeHost.file }],
                display: { flowLayer: 1 },
            });
            addEdge(edges, {
                id: `edge-worker--${id}`,
                from: "edge-worker",
                to: id,
                kind: "depends_on",
                evidence: "declared",
            });
        }
    }

    // 7c. Package districts for code not claimed by a deployed service.
    // A real runnable package (CLI, web app) keeps its building. A generic
    // package (role "package") would produce one synthetic building holding
    // everything, so it is flattened: its rooms are promoted to campus-level
    // structures, each expandable into a building when its directory has
    // internal structure.
    /**
     * Groups a room's files into child modules: one group per immediate
     * subdirectory, an own-named group for each loose file nothing imports (a
     * CLI, an installer — its own module, not filing material), and a
     * "(files)" group for loose files the entries import (support code).
     *
     * @param room - Directory-backed room to split into children.
     * @returns One entry per child segment with the files it holds; empty for
     *   the package-root pseudo-room.
     */
    function childRoomsOf(room: Room): { seg: string; files: string[] }[] {
        const prefix =
            room.segment === "(root)" ? null : room.pkg.dir === "." ? room.segment : join(room.pkg.dir, room.segment);
        if (!prefix) return [];
        const groups = new Map<string, string[]>();
        for (const file of room.files) {
            const rest = relative(prefix, file);
            let seg: string;
            if (rest.includes(sep)) {
                const first = rest.split(sep)[0];
                if (first === undefined) throw new Error(`Empty path split: ${rest}`);
                seg = first;
            } else if ((fileCoupling.get(file)?.in ?? 0) === 0) {
                // A loose file nothing imports is its own module (a CLI, an installer),
                // not filing material: give it its own room named after the file.
                seg = rest.replace(/\.[a-z]+$/, "");
            } else {
                seg = "(files)"; // loose files imported by the entries: support code
            }
            groups.set(seg, [...(groups.get(seg) ?? []), file]);
        }
        return [...groups.entries()].map(([seg, files]) => ({ seg, files }));
    }

    /**
     * Source refs for a child of a room: the single file's own path when the
     * child holds exactly one file, the subdirectory when dir-backed, and the
     * concrete files (capped at five) when it is a loose-file group.
     *
     * @param room - Room the child was split from.
     * @param child - Child segment and the files it holds, as produced by
     *   childRoomsOf.
     * @returns Source references pointing at the child's directory or files.
     */
    function childSourceRefs(room: Room, child: { seg: string; files: string[] }): SourceRef[] {
        const dir = roomDir(room);
        if (child.files.length === 1) {
            const only = child.files[0];
            if (only === undefined) throw new Error(`Missing child file for ${child.seg}`);
            return [{ path: only }];
        }
        if (child.seg !== "(files)" && child.files.every((f) => f.startsWith(join(dir, child.seg) + sep))) {
            return [{ path: join(dir, child.seg) }];
        }
        return child.files.slice(0, 5).map((path) => ({ path }));
    }

    /**
     * Decides whether a room has interior structure worth expanding into a
     * building: two subdirs, or one subdir plus loose files.
     *
     * @param room - Room to test.
     * @returns True when the room should expand into child structures.
     */
    function hasInteriorStructure(room: Room): boolean {
        const allChildren = childRoomsOf(room);
        const dirChildren = allChildren.filter(({ seg }) => seg !== "(files)");
        return dirChildren.length >= 2 || (dirChildren.length >= 1 && allChildren.length >= 2);
    }

    const promotedNodes: { id: string; files: string[] }[] = []; // district-less / own-district residual nodes
    for (const pkg of packages) {
        const pkgRooms = [...rooms.values()].filter((room) => {
            if (room.pkg !== pkg || room.files.length === 0) return false;
            if (claimedSegments.has(pkg.dir === "." ? room.segment : join(pkg.dir, room.segment))) return false;
            if (isUtilityRoom(room.id)) return false;
            // lib rooms are shared plumbing, not deployment shape: excluded by
            // decision, like the C2-eliminated utility rooms.
            if (basename(room.segment) === "lib") return false;
            // Orphans: imported by nothing, reachable from nothing, no OTLP coupling,
            // not an entry dir, not referenced by path from another package. Sample
            // and demo material (examples/) falls out here.
            if (
                !pathReassignments.has(room.id) &&
                (roomCoupling.get(room.id)?.in ?? 0) === 0 &&
                !entryDirNames.has(basename(room.segment)) &&
                room.files.every((f) => !deployReachable.has(f) && !scriptReachable.has(f)) &&
                !room.files.some((f) => OTLP_PATTERN.test(readText(join(repo, f))))
            ) {
                warnings.push(
                    `Orphan area excluded (unreferenced, undeployed): ${room.segment} (${room.files.length} files).`,
                );
                return false;
            }
            return true;
        });
        if (!pkgRooms.length) continue;
        const scopeId = `${pkg.id}-area`;
        // Residual: compose services already claimed part of this package, so the
        // remaining code is operator tooling rather than the deployable itself.
        const residual = [...serviceClaimedDirs].some((dir) => owningPackage(dir) === pkg);

        // R5: a whole package that no host deploy root reaches is development
        // scaffolding (an e2e harness, a dev-only plugin SDK) — it leaves the
        // deployment view, the way R2 strips dev-tooling files within a package.
        // Only fires when the repo has a real deployment shape, so a library
        // monorepo is untouched until D14 recognises its published packages; a
        // residual or path-referenced package is spared, and the overview keeps
        // these packages, so this is deployment-view-only.
        const packageDeployed = pkgRooms.some((room) => room.files.some((f) => hostDeployReachable.has(f)));
        const pathReferenced = pkgRooms.some((room) => pathReassignments.has(room.id));
        // A published artefact (D14) or a runnable app (D16) is deployed by
        // publication or by being run, not by a host, so R5 must not strip it
        // even though no host root reaches it.
        if (
            hasHostDeployShape &&
            !residual &&
            !pathReferenced &&
            !packageDeployed &&
            pkg.artefact === null &&
            !runnableByDir.has(pkg.dir)
        ) {
            warnings.push(
                `Dev-only package excluded from the deployment view (reached by no host deploy root): ${pkg.name} (${pkgRooms.length} area${pkgRooms.length === 1 ? "" : "s"}).`,
            );
            continue;
        }

        const entries = pkgRooms
            .filter((r) => entryDirNames.has(basename(r.segment)) || r.segment === "(root)")
            .map((r) => r.id);
        const layers = layerByLongestPath(
            pkgRooms.map((r) => r.id),
            roomEdges,
            entries,
        );

        // A district never wraps a single synthetic building: rooms are promoted to
        // campus structures directly. Non-residual packages keep a package district
        // as the grouping; residual leftovers get a district per structured dir
        // (devstack, bootstrap) and district-less nodes for flat dirs.
        if (!residual && !nodes.some((n) => n.id === scopeId)) {
            nodes.push({
                id: scopeId,
                label: titleCase(pkg.name),
                kind: "scope",
                archetype: "district",
                description: `Package ${pkg.name}, rooted at ${pkg.dir === "." ? "the repository root" : `${pkg.dir}/`}.`,
            });
        }
        for (const room of pkgRooms) {
            const expandable = hasInteriorStructure(room);
            const children = expandable ? childRoomsOf(room) : [];
            const label = roomLabel(room.segment);
            let parentId: string | undefined;
            const reassigned = pathReassignments.get(room.id);
            if (reassigned) {
                const reassignedPkg = reassigned.pkg;
                parentId = `${reassignedPkg.id}-area`;
                if (!nodes.some((n) => n.id === parentId)) {
                    nodes.push({
                        id: parentId,
                        label: titleCase(reassignedPkg.name),
                        kind: "scope",
                        archetype: "district",
                        description: `Package ${reassignedPkg.name}, rooted at ${reassignedPkg.dir === "." ? "the repository root" : `${reassignedPkg.dir}/`}.`,
                    });
                }
                const fromRoom = fileToRoom.get(reassigned.fromFile);
                if (fromRoom) {
                    addEdge(edges, {
                        id: `${fromRoom.id}--${room.id}`,
                        from: fromRoom.id,
                        to: room.id,
                        kind: "depends_on",
                        evidence: "declared",
                        label: "path reference",
                        sourceRefs: [{ path: reassigned.fromFile }],
                    });
                }
            } else if (!residual) {
                parentId = scopeId;
            } else if (expandable) {
                // A residual structured dir never wraps a single building either: the
                // district holds the dir's parts directly as campus structures.
                const districtId = `${room.id}-district`;
                nodes.push({
                    id: districtId,
                    label,
                    kind: "scope",
                    archetype: "district",
                    description: `Standalone area: ${room.segment}/.`,
                });
                for (const child of children) {
                    // Loose imported files ("Support files") and lib children are shared
                    // plumbing, not deployment shape: excluded by decision.
                    if (child.seg === "(files)" || child.seg === "lib") continue;
                    const childId = uniqueNodeId(kebab(`${room.id}-${child.seg}`));
                    const childLoc = linesOf(repo, child.files);
                    const childAsBuilding = modulesAsBuildings && child.files.length >= 2;
                    // Same entry classification as the overview (O2): a script-referenced
                    // file or an entry-named loose file (redeploy-cli) is an entry point.
                    const childIsEntry = isEntryPoint({
                        files: child.files,
                        scriptReferencedFiles,
                        nameArm: { granularity: "child", seg: child.seg },
                    });
                    const childEntryFile = child.files[0];
                    nodes.push({
                        id: childId,
                        label: titleCase(child.seg),
                        kind: "module",
                        archetype: childAsBuilding ? "building" : childIsEntry ? "gateway" : "worker",
                        ...(childIsEntry && child.files.length === 1 && childEntryFile !== undefined
                            ? { attributes: { "entry-point": childEntryFile } }
                            : {}),
                        parentId: districtId,
                        description: `${child.files.length} source file${child.files.length === 1 ? "" : "s"} under ${room.segment}/.`,
                        sourceRefs: childSourceRefs(room, child),
                        metrics: { loc: childLoc },
                    });
                    if (childAsBuilding) pushFileRooms(childId, child.files);
                    for (const f of child.files) fileNodeOwner.set(f, childId);
                    promotedNodes.push({ id: childId, files: child.files });
                }
                continue;
            }
            // Not the isEntryPoint rule: this is a room-level archetype choice
            // (gateway vs worker) from the directory name alone. isEntryPoint
            // also treats a script-referenced file as an entry, which would
            // change archetypes here, so the two stay separate by design.
            const isEntry = entryDirNames.has(basename(room.segment));
            const leafAsBuilding = modulesAsBuildings && !expandable && room.files.length >= 2;
            nodes.push({
                id: room.id,
                label,
                kind: "module",
                archetype: expandable || leafAsBuilding ? "building" : isEntry ? "gateway" : "worker",
                ...(parentId ? { parentId } : {}),
                description: `${room.files.length} source file${room.files.length === 1 ? "" : "s"} under ${room.segment === "(root)" ? "the package root" : `${room.segment}/`}.`,
                sourceRefs:
                    room.segment === "(root)"
                        ? room.files.slice(0, 5).map((path) => ({ path }))
                        : [{ path: roomDir(room) }],
                metrics: { loc: room.loc },
                display: { flowLayer: layers.get(room.id) ?? 0 },
            });
            for (const f of room.files) fileNodeOwner.set(f, room.id);
            promotedNodes.push({ id: room.id, files: room.files });
            if (leafAsBuilding) pushFileRooms(room.id, room.files);
            if (expandable) {
                for (const child of children) {
                    if (child.seg === "lib") continue; // shared plumbing, not shape
                    nodes.push({
                        id: uniqueNodeId(kebab(`${room.id}-${child.seg}`)),
                        label: child.seg === "(files)" ? "Top-level files" : titleCase(child.seg),
                        kind: "module",
                        archetype: "room",
                        parentId: room.id,
                        description: `${child.files.length} source file${child.files.length === 1 ? "" : "s"}.`,
                        sourceRefs: childSourceRefs(room, child),
                    });
                }
            }
        }
    }

    // 7c-i. The web entry deploys to the edge worker: wrangler builds and serves
    // the owning package's app, so the app entry carries a deploys edge.
    if (edgeHost && nodes.some((n) => n.id === "edge-worker")) {
        const ownerPkg = owningPackage(edgeHost.file);
        const entryRoom = [...rooms.values()].find(
            (r) => r.pkg === ownerPkg && entryDirNames.has(basename(r.segment)) && nodes.some((n) => n.id === r.id),
        );
        if (entryRoom) {
            addEdge(edges, {
                id: `${entryRoom.id}--edge-worker`,
                from: entryRoom.id,
                to: "edge-worker",
                kind: "deploys",
                evidence: "declared",
                label: "wrangler deploy",
                sourceRefs: [{ path: edgeHost.file }],
            });
        }
    }

    // 7c-ii. OTLP producers: residual nodes whose source configures OpenTelemetry
    // export get a data_flow edge into the OTLP-receiving collector, pulling data
    // generators and agent plugins toward the ingress host they feed.
    const collectorTarget =
        nodes.find((n) => n.kind !== "scope" && /otel|collector/.test(n.id) && /gateway/.test(n.id)) ??
        nodes.find((n) => n.kind !== "scope" && /otel|collector/.test(n.id));
    if (collectorTarget) {
        inferModuleDataFlows({ entries: promotedNodes, edges, fileText, otlpTargetId: collectorTarget.id });
    }

    // 7c-iii (removed): eliminated shared-utility rooms used to reappear as a
    // per-district "Shared libraries" copy. Dropped by decision — the copies
    // repeated across every district without adding information; C2 elimination
    // now simply removes shared code from the deployment map.

    // 7d. Room-level and package-level import edges (only between nodes that exist).
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const [key, count] of roomEdges) {
        const [from, to] = splitEdgeKey(key);
        if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
        addEdge(edges, {
            id: `${from}--${to}`,
            from,
            to,
            kind: "depends_on",
            evidence: "declared",
            label: `${count} import${count === 1 ? "" : "s"}`,
        });
    }
    for (const key of packageEdges.keys()) {
        const [from, to] = splitEdgeKey(key);
        if (nodeIds.has(from) && nodeIds.has(to)) {
            addEdge(edges, { id: `${from}--${to}`, from, to, kind: "depends_on", evidence: "declared" });
        }
    }

    // 7d-ii. Owner-level import edges: aggregate file imports by emitted campus
    // node. Covers flattened district children, which the room-level pass above
    // cannot see; addEdge's id dedup keeps existing pairs untouched.
    const ownerEdgeCounts = new Map<string, number>();
    for (const { from, to } of fileEdges) {
        const a = fileNodeOwner.get(from);
        const b = fileNodeOwner.get(to);
        if (!a || !b || a === b || !nodeIds.has(a) || !nodeIds.has(b)) continue;
        const key = `${a}->${b}`;
        ownerEdgeCounts.set(key, (ownerEdgeCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of ownerEdgeCounts) {
        const [from, to] = splitEdgeKey(key);
        addEdge(edges, {
            id: `${from}--${to}`,
            from,
            to,
            kind: "depends_on",
            evidence: "declared",
            label: `${count} import${count === 1 ? "" : "s"}`,
        });
    }

    // 7e. Drizzle database when no D1 binding declared it already.
    if (drizzleConfig && ![...nodeIds].some((id) => id.startsWith("d1-"))) {
        const dialect = /dialect:\s*["'](\w+)["']/.exec(readText(join(repo, drizzleConfig)))?.[1];
        const owner = owningPackage(drizzleConfig);
        const parent = edgeHost ? "edge-delivery" : owner ? `${owner.id}-area` : undefined;
        if (parent && nodeIds.has(parent)) {
            nodes.push({
                id: "drizzle-database",
                label: `Database (${dialect ?? "sql"})`,
                kind: "infra",
                archetype: "database",
                parentId: parent,
                description: `Drizzle ORM schema declared in ${drizzleConfig}.`,
                sourceRefs: [{ path: drizzleConfig }],
                display: { flowLayer: 1 },
            });
            const from = edgeHost ? "edge-worker" : owner?.id;
            // nodeIds is a snapshot taken before this section; nodes.some also
            // covers anything pushed since, so it subsumes the snapshot check.
            if (from !== undefined && nodes.some((n) => n.id === from)) {
                addEdge(edges, {
                    id: `${from}--drizzle-database`,
                    from,
                    to: "drizzle-database",
                    kind: "depends_on",
                    evidence: "declared",
                });
            }
        }
    }

    // 7e-i. Embedded databases (same dependency scan as overview mode's O11):
    // the node lives in the district of the first module importing the SDK, and
    // importers get inferred reads/writes data flow. One index entry per owned
    // source file, so importer order replays the sourceFiles order.
    const ownedFileEntries: NodeIndexEntry[] = [];
    for (const file of sourceFiles) {
        const owner = fileNodeOwner.get(file);
        if (owner && nodes.some((n) => n.id === owner)) ownedFileEntries.push({ id: owner, files: [file] });
    }
    inferEmbeddedDatabaseUse({
        databases: embeddedDatabases,
        entries: ownedFileEntries,
        edges,
        fileText,
        edgeSuffix: "",
        onImporters: (database, importerOwners) => {
            const parentDistrict = importerOwners
                .map((owner) => nodes.find((n) => n.id === owner)?.parentId)
                .find((parent) => parent && nodes.some((n) => n.id === parent && n.kind === "scope"));
            nodes.push({
                id: database.id,
                label: database.label,
                kind: "infra",
                archetype: "database",
                ...(parentDistrict ? { parentId: parentDistrict } : {}),
                description: database.description,
                sourceRefs: [{ path: database.path }],
                display: { flowLayer: 2 },
            });
        },
    });

    // 7e-i-b. D17: external services a package talks to via a client SDK (an IMAP
    // mail server, an LLM API). One external node in the externals district, with
    // an inferred data_flow "uses" edge from each module whose source imports the
    // SDK. Drawn only when a deployed module actually imports it, so a bare
    // dependency does not conjure a phantom external.
    for (const service of externalServiceDeps) {
        const importerIds = sdkImporterIds(service.depNames, ownedFileEntries, fileText);
        if (importerIds.length === 0) continue;
        nodes.push({
            id: service.id,
            label: service.label,
            kind: "external",
            archetype: "cloud",
            parentId: ensureExternalsDistrict(),
            description: service.description,
            sourceRefs: [{ path: service.path }],
            display: { flowLayer: 2 },
        });
        for (const importer of importerIds) {
            addEdge(edges, {
                id: `${importer}--${service.id}`,
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

    // 7e-ii. CI workflow jobs (D9-D12). A GitHub Actions workflow with a schedule,
    // a workflow_run chain, or a run step invoking repo code becomes a CI job
    // district. Object-storage traffic becomes an external store with directional
    // data flow; an invoked entry's Commander subcommand resolves to its handler
    // module for a `runs` edge.
    /**
     * Finds the emitted campus node that owns a source file: the direct
     * fileNodeOwner mapping when present, else the non-scope node whose
     * longest sourceRef path contains the file.
     *
     * @param file - Repository-relative source file to attribute.
     * @returns The owning node's id, or null when nothing on the map claims
     *   the file.
     */
    const nodeOwningFile = (file: string): string | null => {
        const direct = fileNodeOwner.get(file);
        if (direct && nodes.some((n) => n.id === direct)) return direct;
        let best: { id: string; length: number } | null = null;
        for (const node of nodes) {
            if (node.kind === "scope") continue;
            for (const ref of node.sourceRefs ?? []) {
                if (!ref.path) continue;
                if (file === ref.path || file.startsWith(`${ref.path.replace(/\/$/, "")}/`)) {
                    if (!best || ref.path.length > best.length) best = { id: node.id, length: ref.path.length };
                }
            }
        }
        return best?.id ?? null;
    };
    /**
     * Resolves a Commander subcommand to the module that implements it: the
     * handler is the first braced named import used inside the
     * `.command('<sub>')` chunk of the entry file, resolved back through the
     * import graph. Default and namespace imports are not scanned.
     *
     * @param entryFile - CLI entry file that registers the subcommand.
     * @param sub - Subcommand name as invoked by the CI workflow.
     * @returns The handler module's repository-relative path, or null when
     *   the subcommand or its handler cannot be resolved.
     */
    const subcommandHandlerFile = (entryFile: string, sub: string): string | null => {
        const text = readText(join(repo, entryFile));
        const importedNames = new Map<string, string>(); // identifier -> specifier
        for (const match of text.matchAll(/import\s*{([^}]+)}\s*from\s*['"]([^'"]+)['"]/g)) {
            const names = match[1];
            const specifier = match[2];
            if (names === undefined || specifier === undefined) continue;
            for (const raw of names.split(",")) {
                const identifier = raw
                    .trim()
                    .split(/\s+as\s+/)
                    .pop();
                if (identifier) importedNames.set(identifier, specifier);
            }
        }
        const chunkMatch = new RegExp(
            `\\.command\\(['"]${escapeRegex(sub)}(?:\\s[^'"]*)?['"]\\)([\\s\\S]*?)(?=\\.command\\(|$)`,
        ).exec(text);
        if (!chunkMatch) return null;
        const chunk = chunkMatch[1];
        if (chunk === undefined) throw new Error(`Subcommand chunk missing for ${sub} in ${entryFile}`);
        let first: { at: number; specifier: string } | null = null;
        for (const [identifier, specifier] of importedNames) {
            const at = chunk.indexOf(identifier);
            if (at >= 0 && (!first || at < first.at)) first = { at, specifier };
        }
        if (!first) return null;
        const resolved = resolveImport(entryFile, first.specifier);
        return resolved !== null && "file" in resolved ? resolved.file : null;
    };
    const ciJobId = new Map(ciWorkflows.map((w) => [w.name, kebab(`ci-${w.name}-job`)]));
    for (const workflow of ciWorkflows) {
        // D9 (revised): CI is development infrastructure, not part of the running
        // system, unless the workflow IS the deployment mechanism — a run step
        // invoking source that itself deploys. The proxy is a run-step invocation
        // of deploy-reachable source; lint/release/bot workflows invoke tooling,
        // tests, or nothing, and leave the deployment view. The overview never
        // shows CI, so this is deployment-view-only.
        const deploysSource = workflow.invocations.some((inv) => deployReachable.has(inv.file));
        if (!deploysSource) continue;
        const districtId = kebab(`ci-${workflow.name}`);
        const jobId = ciJobId.get(workflow.name);
        if (jobId === undefined) throw new Error(`CI job id missing for workflow ${workflow.name}`);
        nodes.push({
            id: districtId,
            label: `CI: ${workflow.name}`,
            kind: "scope",
            archetype: "district",
            description: `GitHub Actions workflow declared in ${workflow.file}.`,
        });
        nodes.push({
            id: jobId,
            label: titleCase(workflow.name),
            kind: "deployable",
            archetype: "worker",
            parentId: districtId,
            description: [
                `CI job from ${workflow.file}.`,
                workflow.cron ? `Scheduled (${workflow.cron}).` : null,
                workflow.triggeredBy.length ? `Runs after: ${workflow.triggeredBy.join(", ")}.` : null,
                ...workflow.invocations.map((inv) => `Runs ${inv.file}${inv.sub ? ` ${inv.sub}` : ""}.`),
            ]
                .filter(Boolean)
                .join(" "),
            sourceRefs: [{ path: workflow.file }],
            tags: workflow.cron ? ["cron"] : [],
            display: { flowLayer: 1 },
        });
        if (workflow.storage) {
            const storeId = kebab(`external-${workflow.storage.label}`);
            if (!nodes.some((n) => n.id === storeId)) {
                nodes.push({
                    id: storeId,
                    label: workflow.storage.label,
                    kind: "external",
                    archetype: "storage",
                    parentId: ensureExternalsDistrict(),
                    description: `Object store addressed from CI workflows.`,
                    sourceRefs: [{ path: workflow.file }],
                    display: { flowLayer: 2 },
                });
            }
            if (workflow.storage.downloads) {
                addEdge(edges, {
                    id: `${storeId}--${jobId}`,
                    from: storeId,
                    to: jobId,
                    kind: "data_flow",
                    evidence: "declared",
                    label: "downloads",
                    sourceRefs: [{ path: workflow.file }],
                });
            }
            if (workflow.storage.uploads) {
                addEdge(edges, {
                    id: `${jobId}--${storeId}`,
                    from: jobId,
                    to: storeId,
                    kind: "data_flow",
                    evidence: "declared",
                    label: "uploads",
                    sourceRefs: [{ path: workflow.file }],
                });
            }
        }
        for (const upstream of workflow.triggeredBy) {
            const upstreamId = ciJobId.get(upstream);
            if (upstreamId) {
                addEdge(edges, {
                    id: `${upstreamId}--${jobId}`,
                    from: upstreamId,
                    to: jobId,
                    kind: "calls",
                    evidence: "declared",
                    label: "triggers on completion",
                    sourceRefs: [{ path: workflow.file }],
                });
            }
        }
        for (const invocation of workflow.invocations) {
            const entryOwner = nodeOwningFile(invocation.file);
            if (entryOwner) {
                addEdge(edges, {
                    id: `${jobId}--${entryOwner}`,
                    from: jobId,
                    to: entryOwner,
                    kind: "calls",
                    evidence: "declared",
                    label: `runs ${basename(invocation.file)}${invocation.sub ? ` ${invocation.sub}` : ""}`,
                    sourceRefs: [{ path: workflow.file }],
                });
            }
            if (invocation.sub) {
                const handlerFile = subcommandHandlerFile(invocation.file, invocation.sub);
                const handlerOwner = handlerFile ? nodeOwningFile(handlerFile) : null;
                if (handlerOwner && handlerOwner !== entryOwner && handlerFile) {
                    addEdge(edges, {
                        id: `${jobId}--${handlerOwner}-h`,
                        from: jobId,
                        to: handlerOwner,
                        kind: "calls",
                        evidence: "declared",
                        label: `${invocation.sub} handler`,
                        sourceRefs: [{ path: handlerFile }],
                    });
                }
            }
        }
    }

    // 7c-iv. D14: a non-private package that declares a bin, a library entry,
    // or a VS Code extension is a published deployment artefact. Its entry (the
    // bin target, main/module/exports, or extension main) resolves to source via
    // the dist->src convention; the owning node becomes the deployable — a CLI or
    // extension entry reads as a gateway, a library as a building — tagged by
    // kind so the viewer can distinguish it from a hosted service. One deployable
    // per published package.
    for (const pkg of packages) {
        const artefact = pkg.artefact;
        // A runnable app (D16) is shown as the app it runs, not as a published
        // library, so D14 yields precedence to D16 for it.
        if (artefact === null || runnableByDir.has(pkg.dir)) continue;
        const entrySource = artefactEntryCandidates(pkg).find(fileExists);
        const nodeId = entrySource ? nodeOwningFile(entrySource) : null;
        const node = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
        // Only reclassify a package room; never a hosted service's node.
        if (node === undefined || node.kind !== "module" || (node.parentId ?? "").startsWith("host-")) continue;
        node.kind = "deployable";
        // A library reads as a building, but the validator requires a building to
        // hold at least two rooms; a single-room entry (and every CLI/extension)
        // reads as a gateway, which is valid with or without an interior.
        const childCount = nodes.filter((n) => n.parentId === node.id).length;
        node.archetype = artefact.kind === "library" && childCount >= 2 ? "building" : "gateway";
        node.tags = [...new Set([...(node.tags ?? []), artefact.tag])];
    }

    // 7c-iv-b. D16: a runnable app's entry node becomes a gateway deployable,
    // tagged by how it runs — `server` for a start/serve script that starts a
    // server, `app` for a web SPA rooted at its package. This is how an app you
    // run directly (no compose, wrangler, or publish) enters the deployment view.
    for (const app of runnableApps) {
        const nodeId = nodeOwningFile(app.entry);
        const node = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
        if (node === undefined || node.kind !== "module" || (node.parentId ?? "").startsWith("host-")) continue;
        node.kind = "deployable";
        node.archetype = "gateway";
        node.tags = [...new Set([...(node.tags ?? []), app.tag])];
    }

    // 7c-v. D15: runtime-supervised processes. A deploy-reachable source file
    // that spawns an inventoried entry (found by daemons.ts) starts a daemon: a
    // process node with a `starts`-labelled edge from the supervisor's node. The
    // target is drawn even when it is imported by nothing (a spawned entry is not
    // an orphan), so its process appears; a spawn on a variable or an external
    // command resolved to nothing and is absent here already.
    for (const { caller, target } of spawnedEntries) {
        const supervisorId = nodeOwningFile(caller);
        const supervisor = supervisorId ? nodes.find((n) => n.id === supervisorId) : undefined;
        if (supervisor === undefined) continue;
        const daemonId = kebab(`daemon-${target}`);
        if (!nodes.some((n) => n.id === daemonId)) {
            nodes.push({
                id: daemonId,
                label: titleCase(fileModuleName(target)),
                kind: "deployable",
                archetype: "worker",
                parentId: supervisor.parentId,
                description: `Background process started at runtime (spawned by ${basename(caller)}).`,
                sourceRefs: [{ path: target }],
                metrics: { loc: linesOf(repo, [target]) },
                tags: ["daemon"],
                display: { flowLayer: 1 },
            });
        }
        addEdge(edges, {
            id: `${supervisor.id}--${daemonId}`,
            from: supervisor.id,
            to: daemonId,
            kind: "calls",
            evidence: "inferred",
            confidence: 0.7,
            label: "starts",
            sourceRefs: [{ path: caller }],
        });
    }

    // 7e-iii. Config-declared external services (D12): an https URL assigned as a
    // value in a package-root config.yaml names an external system the package's
    // CLI entry fetches from.
    for (const pkg of packages) {
        const configFile = ["config.yaml", "config.yml"]
            .map((candidate) => (pkg.dir === "." ? candidate : `${pkg.dir}/${candidate}`))
            .find(fileExists);
        if (!configFile) continue;
        const packageJson = (readJson(join(repo, pkg.dir === "." ? "" : pkg.dir, "package.json")) ?? {}) as {
            bin?: string | Record<string, string> | undefined;
        };
        const binTargets =
            typeof packageJson.bin === "string" ? [packageJson.bin] : Object.values(packageJson.bin ?? {});
        const entrySource = binTargets
            .map((target) =>
                join(pkg.dir === "." ? "" : pkg.dir, target)
                    .replace(/(^|\/)dist\//, "$1src/")
                    .replace(/\.js$/, ".ts"),
            )
            .find(fileExists);
        const fromId = entrySource ? nodeOwningFile(entrySource) : null;
        for (const line of readText(join(repo, configFile)).split("\n")) {
            if (/^\s*#/.test(line)) continue;
            const urlMatch = /:\s*['"]?(https:\/\/[^'"\s]+)/.exec(line);
            if (!urlMatch) continue;
            const matchedUrl = urlMatch[1];
            if (matchedUrl === undefined) throw new Error(`URL capture missing in ${configFile}`);
            let hostname: string;
            try {
                hostname = new URL(matchedUrl).hostname;
            } catch {
                continue;
            }
            if (/localhost|^127\.|cloudflarestorage\.com$/.test(hostname)) continue;
            const externalId = kebab(`external-${hostname}`);
            if (!nodes.some((n) => n.id === externalId)) {
                nodes.push({
                    id: externalId,
                    label: hostname,
                    kind: "external",
                    archetype: "cloud",
                    parentId: ensureExternalsDistrict(),
                    description: `External service configured in ${configFile}.`,
                    sourceRefs: [{ path: configFile }],
                    display: { flowLayer: 0 },
                });
            }
            if (fromId) {
                addEdge(edges, {
                    id: `${externalId}--${fromId}`,
                    from: externalId,
                    to: fromId,
                    kind: "data_flow",
                    evidence: "declared",
                    label: "fetches",
                    sourceRefs: [{ path: configFile }],
                });
            }
        }
    }

    // 7f. Static I/O classification (data flow from code, no runtime evidence).
    // Declared boundary roles become tags: a module that starts a server listens;
    // one that constructs HTTP clients calls out. Database sinks/sources become
    // directional data_flow edges: SQL/ORM writes flow node -> database, reads
    // flow database -> node. Inferred evidence, because the *binding* to a
    // specific database node is not stated in the code.
    const classificationSets: { id: string; files: string[]; entryFile?: string | null | undefined }[] = [
        ...campusFileSets,
        ...promotedNodes.map(({ id, files }) => ({ id, files })),
    ];
    const districtLookup = new Map<string, string | undefined>(
        nodes
            .filter((n) => n.parentId && nodes.some((s) => s.id === n.parentId && s.kind === "scope"))
            .map((n) => [n.id, n.parentId]),
    );
    const databaseNodes = nodes.filter((n) => n.archetype === "database");

    // 7f-i. Nodes referencing an external by SDK import or env-var prefix deliver
    // data to it (the delivery command pushing scores into Langfuse/Latitude).
    // Mirrors overview mode's delivers inference.
    inferExternalDelivers({
        externals: nodes.filter((n) => n.kind === "external"),
        entries: classificationSets,
        edges,
        fileText,
    });

    for (const { id, files, entryFile } of classificationSets) {
        const node = nodes.find((n) => n.id === id);
        if (!node || !files.length) continue;
        // Deployment structures size like overview modules (O5): height from lines
        // of code, floor area from the worst single function inside. Height is
        // log-scaled — these are multi-file aggregates (services run to 5 figures
        // of loc) and the overview's linear cap would flatten them all.
        const sizedLoc = linesOf(repo, files);
        const sizedComplexity = Math.max(...files.map((f) => fileMaxFunctionComplexity(f)));
        const sizedHeight = Math.max(0.6, 0.6 + Math.log2(1 + sizedLoc / 200) * 0.55);
        const sizedFootprint = footprintFor(sizedComplexity);
        const coverage = coverageForFiles(files);
        node.metrics = {
            ...(node.metrics ?? {}),
            loc: sizedLoc,
            complexity: sizedComplexity,
            ...(coverage !== null ? { coverage } : {}),
        };
        node.display = { ...(node.display ?? {}), size: [sizedFootprint, sizedHeight, sizedFootprint * 0.85] };
        // TSDoc prose leads the description as its own paragraph: the node's
        // DECLARED entry file wins (a service's Dockerfile entrypoint), else the
        // best entry-like file by name.
        const doc = (entryFile ? fileDocSummary(entryFile) : null) ?? docForFiles(files);
        if (doc && !node.description?.startsWith(doc)) {
            node.description = [doc, node.description].filter(Boolean).join("\n\n");
        }
        let listens = false;
        let callsOut = false;
        for (const file of files) {
            const text = readText(join(repo, file));
            listens ||= LISTEN_PATTERN.test(text);
            callsOut ||= HTTP_CLIENT_PATTERN.test(text);
        }
        const tags = new Set(node.tags ?? []);
        if (listens) tags.add("listens");
        if (callsOut) tags.add("http-client");
        if (tags.size) node.tags = [...tags];
    }

    // Database sinks/sources over the same classification sets, preferring the
    // district-local database over the first one declared.
    inferModuleDataFlows({
        entries: classificationSets
            .filter(({ id, files }) => files.length && nodes.some((n) => n.id === id))
            .map(({ id, files }) => ({ id, files, districtId: districtLookup.get(id) })),
        edges,
        fileText,
        database: {
            databases: databaseNodes.map((db) => ({ id: db.id, districtId: districtLookup.get(db.id) })),
            writePattern: dbWritePattern,
            readPattern: dbReadPattern,
        },
    });

    return { nodes, edges, warnings };
}
