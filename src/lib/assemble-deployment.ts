/**
 * Deployment-map assembly (section 7 of the generator). Turns the deployment
 * shape (compose hosts, wrangler edge config, CI workflows), the room/package
 * structure, and the import graph into the city map's nodes, edges, and
 * warnings. D9-D12, C2 and the O-series parallels are HEURISTICS.md rule
 * IDs; the 7a-7f markers are this file's own section headings, inherited
 * from section 7 of the pre-extraction generator, and are not in the rule
 * catalogue.
 */
import { join } from "node:path";
import {
    type AssemblyState,
    assembleCiWorkflows,
    assembleConfigExternals,
    assembleDaemons,
    assembleDatabases,
    assembleEdgeDistrict,
    assembleExternalServiceSdks,
    assembleHostDistricts,
    assembleImportEdges,
    assemblePackageDistricts,
    assembleStaticClassification,
    reclassifyPublishedArtefacts,
    reclassifyRunnableApps,
} from "./assemble-deployment-phases.ts";
import { fileModuleName, uniqueId } from "./assembly-helpers.ts";
import { COUPLING_THRESHOLDS, type Coupling, type CouplingAnalysis } from "./coupling.ts";
import type { SpawnedEntry } from "./daemons.ts";
import type { HostScanResult } from "./host-config.ts";
import { type Host, isServiceShadowed, type ServiceIdentity } from "./hosts.ts";
import type { FileEdge, MapEdge, MapNode } from "./map-types.ts";
import { owningPackage as owningPackageOf, type Package } from "./packages.ts";
import type { PathReassignment } from "./path-references.ts";
import { readText } from "./read.ts";
import type { Room } from "./rooms.ts";
import type { RunnableApp } from "./runnable.ts";
import type { EmbeddedDatabase, ExternalServiceDep } from "./scans.ts";
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
    devToolingWarnings: readonly string[];
    pathReassignments: Map<string, PathReassignment>;
    entryDirNames: ReadonlySet<string>;
    dbWritePattern: RegExp;
    dbReadPattern: RegExp;
    dbClientPattern: RegExp;
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
        spawnedEntries,
        runnableApps,
        devToolingWarnings,
        pathReassignments,
        entryDirNames,
        dbWritePattern,
        dbReadPattern,
        dbClientPattern,
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
    const isShadowed = (host: Host, service: ServiceIdentity): boolean =>
        isServiceShadowed(serviceOwner, host, service);

    /**
     * Finds the emitted campus node that owns a source file: the direct
     * fileNodeOwner mapping when present, else the non-scope node whose
     * longest sourceRef path contains the file. Defined here rather than in its
     * first-use phase (7e-ii) because the CI, D14/D16, daemon (7c-v), and
     * config-external (7e-iii) phases all resolve files to nodes through it.
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

    // The mutable substrate every extracted phase works against: the map
    // accumulators, the file-to-node index, and the shared helper closures.
    const state: AssemblyState = {
        repo,
        nodes,
        edges,
        warnings,
        fileNodeOwner,
        fileExists,
        fileText,
        owningPackage,
        uniqueNodeId,
        pushFileRooms,
        ensureExternalsDistrict,
        nodeOwningFile,
        isShadowed,
        scriptReachable,
    };

    // 7a / 7a-ii / 7a-iii. Host districts, service wiring, and host-to-host forwarding.
    assembleHostDistricts(state, {
        hosts,
        hostLayer,
        candidateHosts,
        serviceDependsOn,
        hostScan,
        rooms,
        sourceFiles,
        fileToRoom,
        isUtilityRoom,
        fileEdges,
        hostLayerBase: HOST_LAYER_BASE,
        claimedSegments,
        serviceClaimedDirs,
        campusFileSets,
    });

    // 7b. Cloudflare edge district (worker + D1 bindings).
    assembleEdgeDistrict(state, { edgeHost, claimedSegments });

    // 7c / 7c-i / 7c-ii. Package districts for unclaimed code, the wrangler
    // deploys edge, and OTLP producers; returns the promoted nodes for 7f.
    const promotedNodes = assemblePackageDistricts(state, {
        packages,
        rooms,
        claimedSegments,
        serviceClaimedDirs,
        isUtilityRoom,
        pathReassignments,
        roomCoupling,
        fileCoupling,
        entryDirNames,
        deployReachable,
        scriptReachable,
        hostDeployReachable,
        hasHostDeployShape,
        runnableByDir,
        hosts,
        roomEdges,
        fileToRoom,
        modulesAsBuildings,
        edgeHost,
    });

    // 7d / 7d-ii. Import edges between emitted nodes; returns the id snapshot.
    const nodeIds = assembleImportEdges(state, { roomEdges, packageEdges, fileEdges });

    // 7e / 7e-i. Database nodes (drizzle + embedded); returns the owned-file index.
    const ownedFileEntries = assembleDatabases(state, {
        drizzleConfig,
        edgeHost,
        sourceFiles,
        embeddedDatabases,
        nodeIds,
    });

    // 7e-i-b. D17: external services a package talks to via a client SDK.
    assembleExternalServiceSdks(state, { externalServiceDeps, ownedFileEntries });

    // 7e-ii. CI workflow jobs (D9-D12): a scheduled, chained, or deploying
    // workflow becomes a CI job district with storage, trigger, and runs edges.
    assembleCiWorkflows(state, { ciWorkflows, deployReachable, resolveImport });

    // 7c-iv / 7c-iv-b. D14 published artefacts and D16 runnable apps: reclassify
    // the owning package room into a tagged deployable (D14 yields to D16).
    reclassifyPublishedArtefacts(state, { packages, runnableByDir });
    reclassifyRunnableApps(state, { runnableApps });

    // 7c-v. D15: runtime-supervised processes spawned from deploy-reachable code.
    assembleDaemons(state, { spawnedEntries });

    // 7e-iii. Config-declared external services (D12).
    assembleConfigExternals(state, { packages });

    // 7f / 7f-i and the final database pass: static I/O classification — size
    // and describe the campus/promoted nodes, tag declared boundary roles, and
    // draw the delivers and database data-flow edges.
    assembleStaticClassification(state, {
        campusFileSets,
        promotedNodes,
        fileMaxFunctionComplexity,
        coverageForFiles,
        fileDocSummary,
        docForFiles,
        dbWritePattern,
        dbReadPattern,
        dbClientPattern,
    });

    return { nodes, edges, warnings };
}
