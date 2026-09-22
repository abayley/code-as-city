/**
 * Deployment-map assembly phases extracted from `assemble-deployment.ts`
 * (section 7). Each function is one heuristic's pass: it takes the accumulators
 * it appends to (or the nodes it reclassifies) plus the narrow slice of context
 * and shared helpers it needs, and mutates them in place, mirroring the pass
 * style of `inference.ts`. The orchestrator in `assemble-deployment.ts` calls
 * them in order. The 7x markers are that file's own section headings; D12-D17
 * are HEURISTICS.md rule IDs.
 */
import { basename, dirname, join, relative, sep } from "node:path";
import {
    addEdge,
    deploymentFootprintFor,
    escapeRegex,
    fileModuleName,
    linesOf,
    packageDistrictLabel,
    roomLabel,
    splitEdgeKey,
} from "./assembly-helpers.ts";
import { isExcludedCopyDir, normaliseCopyDir } from "./copy-attribution.ts";
import type { Coupling } from "./coupling.ts";
import type { SpawnedEntry } from "./daemons.ts";
import { layerByLongestPath } from "./flow.ts";
import type { HostScanResult } from "./host-config.ts";
import type { Host, HostService, ServiceIdentity } from "./hosts.ts";
import type { NodeIndexEntry } from "./inference.ts";
import {
    classifiedVariantServices,
    inferEmbeddedDatabaseUse,
    inferExternalDelivers,
    inferExternalServiceUse,
    inferModuleDataFlows,
} from "./inference.ts";
import type { FileEdge, MapEdge, MapNode, SourceRef } from "./map-types.ts";
import { artefactEntryCandidates, type Package } from "./packages.ts";
import type { PathReassignment } from "./path-references.ts";
import { readJson, readText } from "./read.ts";
import { type Room, roomDir } from "./rooms.ts";
import type { RunnableApp } from "./runnable.ts";
import { type EmbeddedDatabase, type ExternalServiceDep, OTLP_PATTERN } from "./scans.ts";
import { kebab, titleCase } from "./text.ts";
import type { CiWorkflow } from "./workflows.ts";
import type { EdgeHost } from "./wrangler.ts";

/** A resolved import specifier: a local file, a local package, or a bare name. */
type ResolvedImport = { file: string } | { pkg: Package } | { bare: string };

/** A node's file set for static I/O classification: campus and promoted nodes alike. */
type ClassificationSet = { id: string; files: string[]; entryFile?: string | null | undefined };

// 7f static I/O classification patterns (declared boundary roles).
const LISTEN_PATTERN = /Bun\.serve|\.listen\s*\(|createServer\s*\(|@fastify|express\s*\(\)/;
const HTTP_CLIENT_PATTERN = /\bfetch\s*\(|axios[.(]|new\s+Request\s*\(/;

/**
 * The mutable substrate a deployment-assembly phase works against: the map
 * accumulators, the central file-to-node index, and the shared helper closures
 * the orchestrator builds once. A phase reads the slice it needs and appends to
 * `nodes`/`edges`/`warnings` in place; the intermediate handoff values that flow
 * from one phase to the next (claimed dirs, promoted nodes, campus file sets)
 * are passed explicitly rather than carried here, so the pipeline's data flow
 * stays visible.
 */
export type AssemblyState = {
    /** Absolute path of the repository being mapped. */
    repo: string;
    /** The map nodes accumulated so far; phases append to and reclassify these. */
    nodes: MapNode[];
    /** The map edges accumulated so far. */
    edges: MapEdge[];
    /** The map warnings accumulated so far. */
    warnings: string[];
    /** Source file -> emitted campus node id, populated as nodes are drawn. */
    fileNodeOwner: Map<string, string>;
    /** Whether a repo-relative path is in the scanned inventory. */
    fileExists: (p: string) => boolean;
    /** Reads a repo-relative file's text. */
    fileText: (file: string) => string;
    /** The package owning a file or directory, or null. */
    owningPackage: (file: string) => Package | null;
    /** Allocates a node id free in both the node set and the room-id namespace. */
    uniqueNodeId: (base: string) => string;
    /** Emits one room node per source file inside a building (--modules-as-buildings). */
    pushFileRooms: (parentId: string, files: readonly string[]) => void;
    /** Creates the shared externals district on first use and returns its id. */
    ensureExternalsDistrict: () => string;
    /** The emitted node owning a source file (direct mapping, else longest sourceRef). */
    nodeOwningFile: (file: string) => string | null;
    /** Whether a service is shadowed by its canonical topology owner (D1, name+image). */
    isShadowed: (host: Host, service: ServiceIdentity) => boolean;
    /** The script-reachable file set (R1): build/operational tooling, not the running system. */
    scriptReachable: ReadonlySet<string>;
};

/**
 * 7c-iv / D14: reclassifies each published-artefact package's room into a
 * deployable. A non-private package that declares a bin, a library entry, or a
 * VS Code extension is published; its entry resolves to source via the
 * dist->src convention, and the owning node becomes the deployable — a CLI or
 * extension reads as a gateway, a library as a building (only when it holds the
 * two rooms the validator requires; otherwise a gateway). A runnable app (D16)
 * takes precedence, so its package is skipped here. A workspace library whose
 * files land in a host image (HC-021: a D3 COPY claims its directory, so it is
 * a component of that deployment, not an artefact of its own) keeps its node
 * with a `bundled` tag instead of a deployable marking — paperclip's bundled
 * adapters read as bundled, and the `published` tag keeps meaning "ships to
 * users". The claim reads two ways (SP-C2): a claimed directory owned by the
 * package, or a claimed file of the package — a coarse COPY of a parent dir
 * (owned by the root) still bundles the files it lands in the image. Mutates
 * matched nodes in place.
 *
 * @param state - The assembly state (`nodes`/`warnings` reclassified in place,
 *   plus `fileExists`/`fileNodeOwner`/`nodeOwningFile`/`owningPackage`).
 * @param options - `packages` to scan; `runnableByDir` to yield D16 precedence;
 *   `serviceClaimedDirs` the D3-claimed dirs a bundled package is read from.
 */
export function reclassifyPublishedArtefacts(
    state: AssemblyState,
    options: {
        packages: readonly Package[];
        runnableByDir: ReadonlyMap<string, RunnableApp>;
        serviceClaimedDirs: ReadonlySet<string>;
    },
): void {
    const { nodes, warnings, fileExists, fileNodeOwner, nodeOwningFile, owningPackage } = state;
    const { packages, runnableByDir, serviceClaimedDirs } = options;
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
        const claimedDir = [...serviceClaimedDirs].some((dir) => owningPackage(dir) === pkg);
        const claimedFile = [...fileNodeOwner].some(
            ([file, owner]) => owner.startsWith("host-") && owningPackage(file) === pkg,
        );
        if (claimedDir || claimedFile) {
            node.tags = [...new Set([...(node.tags ?? []), "bundled"])];
            warnings.push(`Published package bundled into a host image, not a deployable of its own: ${pkg.name}.`);
            continue;
        }
        node.kind = "deployable";
        // A library reads as a building, but the validator requires a building to
        // hold at least two rooms; a single-room entry (and every CLI/extension)
        // reads as a gateway, which is valid with or without an interior.
        const childCount = nodes.filter((n) => n.parentId === node.id).length;
        node.archetype = artefact.kind === "library" && childCount >= 2 ? "building" : "gateway";
        node.tags = [...new Set([...(node.tags ?? []), artefact.tag])];
    }
}

/**
 * 7c-iv-b / D16: reclassifies each runnable app's entry node into a gateway
 * deployable, tagged by how it runs — `server` for a start/serve script that
 * starts a server, `app` for a web SPA rooted at its package. This is how an
 * app run directly (no compose, wrangler, or publish) enters the deployment
 * view. Mutates matched nodes in place.
 *
 * @param state - The assembly state (`nodes` reclassified in place, plus
 *   `nodeOwningFile`).
 * @param options - `runnableApps` the detected apps.
 */
export function reclassifyRunnableApps(state: AssemblyState, options: { runnableApps: readonly RunnableApp[] }): void {
    const { nodes, nodeOwningFile } = state;
    const { runnableApps } = options;
    for (const app of runnableApps) {
        const nodeId = nodeOwningFile(app.entry);
        const node = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
        if (node === undefined || node.kind !== "module" || (node.parentId ?? "").startsWith("host-")) continue;
        node.kind = "deployable";
        node.archetype = "gateway";
        node.tags = [...new Set([...(node.tags ?? []), app.tag])];
    }
}

/**
 * 7e-i-b / D17: draws the external services a package addresses through a
 * client SDK (an IMAP mail server, an LLM API). One external node in the
 * externals district, with an inferred data_flow "uses" edge from each module
 * whose source imports the SDK. Drawn only when a deployed module actually
 * imports it, so a bare dependency does not conjure a phantom external.
 *
 * @param state - The assembly state (`nodes`/`edges` accumulators, `fileText`,
 *   `ensureExternalsDistrict`).
 * @param options - `externalServiceDeps` the detected client-SDK services;
 *   `ownedFileEntries` the file-to-node index the importers are matched against.
 */
export function assembleExternalServiceSdks(
    state: AssemblyState,
    options: { externalServiceDeps: readonly ExternalServiceDep[]; ownedFileEntries: readonly NodeIndexEntry[] },
): void {
    const { nodes, edges, fileText, ensureExternalsDistrict } = state;
    const { externalServiceDeps, ownedFileEntries } = options;
    inferExternalServiceUse({
        services: externalServiceDeps,
        entries: ownedFileEntries,
        edges,
        fileText,
        edgeSuffix: "",
        onImporters: (service) => {
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
        },
    });
}

/**
 * 7e-iii / D12: draws external services declared in a package-root config.yaml.
 * An https URL assigned as a value there names an external system the package's
 * CLI entry fetches from; localhost, loopback, and R2 storage hosts are skipped.
 *
 * @param state - The assembly state (`repo`, `nodes`/`edges`, `fileExists`,
 *   `nodeOwningFile`, `ensureExternalsDistrict`).
 * @param options - `packages` to locate each config and its bin entry.
 */
export function assembleConfigExternals(state: AssemblyState, options: { packages: readonly Package[] }): void {
    const { repo, nodes, edges, fileExists, nodeOwningFile, ensureExternalsDistrict } = state;
    const { packages } = options;
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
}

/**
 * 7c-v / D15: draws runtime-supervised processes. A deploy-reachable source
 * file that spawns an inventoried entry (found by daemons.ts) starts a daemon:
 * a process node with a `starts`-labelled edge from the supervisor's node. The
 * target is drawn even when it is imported by nothing (a spawned entry is not
 * an orphan), so its process appears; a spawn on a variable or an external
 * command resolved to nothing and is absent from `spawnedEntries` already.
 *
 * @param state - The assembly state (`repo`, `nodes`/`edges`, `nodeOwningFile`).
 * @param options - `spawnedEntries` the caller/target spawn pairs.
 */
export function assembleDaemons(state: AssemblyState, options: { spawnedEntries: readonly SpawnedEntry[] }): void {
    const { repo, nodes, edges, nodeOwningFile } = state;
    const { spawnedEntries } = options;
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
}

/**
 * 7e-ii / D9-D12: draws CI workflow jobs. A GitHub Actions workflow with a
 * schedule, a workflow_run chain, or a run step invoking deploy-reachable
 * source becomes a CI job district (CI that is the deployment mechanism, not
 * mere tooling); other workflows leave the deployment view. Object-storage
 * traffic becomes an external store with directional data flow, upstream
 * workflows draw trigger edges, and an invoked entry's Commander subcommand
 * resolves to its handler module for a `runs` edge. Deployment-view only.
 *
 * @param state - The assembly state (`repo`, `nodes`/`edges`,
 *   `ensureExternalsDistrict`, `nodeOwningFile`).
 * @param options - `ciWorkflows` the scanned workflows; `deployReachable` the
 *   deploy-reachable file set (a workflow qualifies by invoking one);
 *   `resolveImport` to trace a subcommand's handler through the import graph.
 */
export function assembleCiWorkflows(
    state: AssemblyState,
    options: {
        ciWorkflows: readonly CiWorkflow[];
        deployReachable: ReadonlySet<string>;
        resolveImport: (fromFile: string, specifier: string) => ResolvedImport | null;
    },
): void {
    const { repo, nodes, edges, ensureExternalsDistrict, nodeOwningFile } = state;
    const { ciWorkflows, deployReachable, resolveImport } = options;
    /**
     * Resolves a Commander subcommand to the module that implements it: the
     * handler is the first braced named import used inside the
     * `.command('<sub>')` chunk of the entry file, resolved back through the
     * import graph. Default and namespace imports are not scanned.
     *
     * @param entryFile - CLI entry file that registers the subcommand.
     * @param sub - Subcommand name as invoked by the CI workflow.
     * @returns The handler module's repository-relative path, or null when the
     *   subcommand or its handler cannot be resolved.
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
}

/**
 * 7f / 7f-i and the final database pass: static I/O classification with no
 * runtime evidence. Sizes each campus/promoted node from its files (O5: height
 * from lines of code, footprint from the worst single function), leads its
 * description with the entry file's TSDoc, and tags declared boundary roles
 * (`listens` for a server, `http-client` for outbound fetch). Then two inferred
 * data-flow passes over the same sets: 7f-i delivers to externals referenced by
 * SDK import or env-var prefix, and the database pass draws SQL/ORM writes
 * (node -> database) and reads (database -> node), preferring the district-local
 * database over the first declared. Evidence is inferred because the binding to
 * a specific database node is not stated in the code.
 *
 * @param state - The assembly state (`repo`, `nodes`/`edges`, `fileText`).
 * @param options - The handoff sets (`campusFileSets` from the host phase,
 *   `promotedNodes` from the package phase) plus the metric, coverage, doc, and
 *   database-pattern lookups used to size, describe, and wire the nodes.
 */
export function assembleStaticClassification(
    state: AssemblyState,
    options: {
        campusFileSets: readonly ClassificationSet[];
        promotedNodes: readonly { id: string; files: string[] }[];
        fileMaxFunctionComplexity: (file: string) => number;
        coverageForFiles: (files: readonly string[]) => number | null;
        fileDocSummary: (file: string) => string | null;
        docForFiles: (files: readonly string[]) => string | null;
        dbWritePattern: RegExp;
        dbReadPattern: RegExp;
        dbClientPattern?: RegExp | undefined;
    },
): void {
    const { repo, nodes, edges, fileText, scriptReachable } = state;
    const {
        campusFileSets,
        promotedNodes,
        fileMaxFunctionComplexity,
        coverageForFiles,
        fileDocSummary,
        docForFiles,
        dbWritePattern,
        dbReadPattern,
        dbClientPattern,
    } = options;
    const classificationSets: ClassificationSet[] = [
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
        // HC-024: build tooling reachable only from scripts ships no data.
        scriptFiles: scriptReachable,
    });

    for (const { id, files, entryFile } of classificationSets) {
        const node = nodes.find((n) => n.id === id);
        if (!node || !files.length) continue;
        // Deployment structures size like overview modules (O5): height from lines
        // of code, floor area from the worst single function inside. Height is
        // log-scaled — these are multi-file aggregates (services run to 5 figures
        // of loc) and the overview's linear cap would flatten them all. The
        // footprint uses a tighter ceiling than overview (deploymentFootprintFor)
        // so a service's base never buries the rear row's nameplate from overhead.
        const sizedLoc = linesOf(repo, files);
        const sizedComplexity = Math.max(...files.map((f) => fileMaxFunctionComplexity(f)));
        const sizedHeight = Math.max(0.6, 0.6 + Math.log2(1 + sizedLoc / 200) * 0.55);
        const sizedFootprint = deploymentFootprintFor(sizedComplexity);
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
            clientPattern: dbClientPattern,
        },
    });
}

/**
 * 7a / 7a-ii / 7a-iii: draws the host districts from the deployment shape.
 * Each compose/topology host becomes a district (flow-layered from the declared
 * forwarding chain); each of its non-shadowed services becomes a node, with
 * per-COPY rooms when the image copies two or more source directories, sized
 * and flow-layered from the local import graph. Then depends_on wiring across
 * compose variants (carrying variant-only backing services onto the surviving
 * host), the empty-district cleanup after D1 consolidation, and host-to-host
 * OTLP forwarding (host-name and service-name matches draw data_flow edges;
 * exporter endpoints naming nothing internal become external receivers).
 *
 * Populates the handoffs the package and classification phases read:
 * `claimedSegments`/`serviceClaimedDirs` (dirs a service owns), `campusFileSets`
 * (each service's files, for I/O classification), and `state.fileNodeOwner`.
 *
 * @param state - The assembly state (`repo`, `nodes`/`edges`, `fileNodeOwner`,
 *   `owningPackage`, `isShadowed`, `ensureExternalsDistrict`).
 * @param options - The deployment-shape inputs (`hosts`, `hostLayer`,
 *   `candidateHosts`, `serviceDependsOn`, `hostScan`), the room/import context
 *   (`rooms`, `sourceFiles`, `fileToRoom`, `isUtilityRoom`, `fileEdges`),
 *   `hostLayerBase` the flow-layer base for hosts, and the mutable handoff
 *   sets `claimedSegments`/`serviceClaimedDirs`/`campusFileSets`.
 */
export function assembleHostDistricts(
    state: AssemblyState,
    options: {
        hosts: readonly Host[];
        hostLayer: ReadonlyMap<string, number>;
        candidateHosts: readonly Host[];
        serviceDependsOn: ReadonlyMap<string, Set<string>>;
        hostScan: readonly HostScanResult[];
        rooms: ReadonlyMap<string, Room>;
        sourceFiles: readonly string[];
        fileToRoom: ReadonlyMap<string, Room>;
        isUtilityRoom: (roomId: string) => boolean;
        fileEdges: readonly FileEdge[];
        hostLayerBase: number;
        claimedSegments: Set<string>;
        serviceClaimedDirs: Set<string>;
        campusFileSets: { id: string; files: string[]; entryFile?: string | null | undefined }[];
    },
): void {
    const { repo, nodes, edges, fileNodeOwner, owningPackage, isShadowed, ensureExternalsDistrict } = state;
    const {
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
        hostLayerBase,
        claimedSegments,
        serviceClaimedDirs,
        campusFileSets,
    } = options;
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
            display: { flowLayer: hostLayerBase + (hostLayer.get(host.name) ?? 0) },
            // REVIEW-0010: a host whose topology is a dev environment carries
            // the tag at the district level as well as on its services.
            ...((host.services.some((s) => s.devEnvironment) ? { tags: ["dev-environment"] } : {}) as object),
        });
        for (const service of host.services) {
            if (isShadowed(host, service)) continue;
            const serviceId = kebab(`${host.id}-${service.name}`);
            const allCopiedSegments = service.copies
                .map(normaliseCopyDir)
                .filter((copy) => copy.includes("/") || rooms.has(`${owningPackage(copy)?.id}-${kebab(copy)}`))
                // A COPY only attributes source when it names a directory that
                // actually holds source: immich's layer-cache `COPY
                // ./server/package.json` names a manifest with no source under
                // it, and claiming it would flip the whole package to the
                // residual path and explode it into per-directory districts.
                // Reachability still counts the raw COPY, so R5 sees the package
                // as host-deployed.
                .filter((copy) => sourceFiles.some((f) => f.startsWith(`${copy}/`)));
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
            // Coupling filter (D3/C2): drop shared lib-like dirs (high fan-in,
            // low fan-out). The rule itself lives in copy-attribution.ts.
            const copiedSegments = allCopiedSegments.filter(
                (copy) => !isExcludedCopyDir(copy, { kind: "utility-room", roomIdForCopy, isUtilityRoom }),
            );
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
            // HC-020: a sibling topology in the same directory shipping the same
            // service name on a different image makes both variants — tag them
            // so a reader sees the alternatives rather than duplicates.
            const isAlternative = candidateHosts
                .filter((variant) => dirname(variant.file) === dirname(host.file))
                .some((variant) => variant.services.some((s) => s.name === service.name && s.image !== service.image));
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
                tags: [
                    isScheduled ? "cron" : null,
                    service.hasPorts ? "listens" : null,
                    isAlternative ? "alternative" : null,
                    // HC-024/REVIEW-0010: a dev container (a bind-mounted
                    // checkout or a dev-server command) — present it as what it is.
                    service.devEnvironment ? "dev-environment" : null,
                ].filter((tag): tag is string => tag !== null),
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
                const variant = variantServices.get(dep);
                // D1: a dependency owned by another topology's canonical file is
                // not re-materialised here — it lives as the owner's single node.
                // The dep's image identity comes from its variant service, so the
                // name-and-image ownership key matches the claim (HC-020).
                if (isShadowed(host, { name: dep, image: variant?.image })) continue;
                const toId = kebab(`${host.id}-${dep}`);
                if (!nodes.some((n) => n.id === toId)) {
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
}

/**
 * 7b: draws the Cloudflare edge district. When a wrangler edge host is present,
 * adds the edge-delivery district, the edge-worker deployable, and one database
 * node per D1 binding (with a depends_on edge from the worker). The worker
 * entry's top segment is claimed so the package phase does not redraw it.
 *
 * @param state - The assembly state (`nodes`/`edges`).
 * @param options - `edgeHost` the wrangler edge host (or null for a no-op);
 *   `claimedSegments` the claimed-dir set, mutated with the worker entry root.
 */
export function assembleEdgeDistrict(
    state: AssemblyState,
    options: { edgeHost: EdgeHost | null; claimedSegments: Set<string> },
): void {
    const { nodes, edges } = state;
    const { edgeHost, claimedSegments } = options;
    if (!edgeHost) return;
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

/**
 * 7c / 7c-i / 7c-ii: draws the package districts for code no deployed service
 * claimed. A real runnable package keeps its building; a generic package is
 * flattened, its rooms promoted to campus-level structures (each expandable
 * into a building when its directory has interior structure). Orphan and
 * dev-only (R5) areas are excluded with a warning; path-reassigned rooms move
 * to the referencing package's district. Then 7c-i draws the wrangler web
 * entry's deploys edge to the edge worker, and 7c-ii draws OTLP producers'
 * data_flow edges into the collector.
 *
 * Populates `state.fileNodeOwner` and returns the promoted nodes for the
 * classification phase.
 *
 * @param state - The assembly state (`repo`, `nodes`/`edges`/`warnings`,
 *   `fileNodeOwner`, `owningPackage`, `uniqueNodeId`, `pushFileRooms`,
 *   `fileText`).
 * @param options - The package/room context and reachability/coupling inputs,
 *   the `claimedSegments`/`serviceClaimedDirs` handoffs from the host and edge
 *   phases, and `edgeHost` for the deploys edge.
 * @returns The promoted (district-less / own-district) nodes with their files,
 *   for the static-classification phase.
 */
export function assemblePackageDistricts(
    state: AssemblyState,
    options: {
        packages: readonly Package[];
        rooms: ReadonlyMap<string, Room>;
        claimedSegments: ReadonlySet<string>;
        serviceClaimedDirs: ReadonlySet<string>;
        isUtilityRoom: (roomId: string) => boolean;
        pathReassignments: ReadonlyMap<string, PathReassignment>;
        roomCoupling: ReadonlyMap<string, Coupling>;
        fileCoupling: ReadonlyMap<string, Coupling>;
        entryDirNames: ReadonlySet<string>;
        deployReachable: ReadonlySet<string>;
        scriptReachable: ReadonlySet<string>;
        hostDeployReachable: ReadonlySet<string>;
        hasHostDeployShape: boolean;
        runnableByDir: ReadonlyMap<string, RunnableApp>;
        hosts: readonly Host[];
        roomEdges: ReadonlyMap<string, number>;
        fileToRoom: ReadonlyMap<string, Room>;
        modulesAsBuildings: boolean;
        edgeHost: EdgeHost | null;
    },
): { id: string; files: string[] }[] {
    const { repo, nodes, edges, warnings, fileNodeOwner, owningPackage, uniqueNodeId, pushFileRooms, fileText } = state;
    const {
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
    } = options;
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
        // campus structures directly. Every package — residual or not — keeps one
        // package district (HC-028): claimed rooms filter out, the leftover rooms
        // and loose root files group under the one district, and a package claimed
        // by one host service takes that service's role label ("Server" from
        // "Immich Server").
        const claimingService = hosts
            .flatMap((h: Host) => h.services)
            .find((s: HostService) => s.copies.some((dir: string) => owningPackage(dir) === pkg));
        if (!nodes.some((n) => n.id === scopeId)) {
            nodes.push({
                id: scopeId,
                label: packageDistrictLabel(
                    pkg,
                    packages,
                    claimingService ? titleCase(claimingService.name) : undefined,
                ),
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
                        label: packageDistrictLabel(reassignedPkg, packages),
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
            } else {
                // Residual or not, the room groups under its package's district
                // (HC-028); the claimed rooms are already filtered out above.
                parentId = scopeId;
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
    return promotedNodes;
}

/**
 * 7d / 7d-ii: draws the import edges between emitted nodes. The room-level and
 * package-level passes turn the room/package edge counts into depends_on edges
 * (only between nodes that exist); the owner-level pass aggregates file imports
 * by emitted campus node, covering flattened district children the room pass
 * cannot see. addEdge's id dedup keeps an existing pair untouched.
 *
 * @param state - The assembly state (`nodes` for the id snapshot, `edges`,
 *   `fileNodeOwner`).
 * @param options - `roomEdges`/`packageEdges` the aggregated edge counts;
 *   `fileEdges` the file-level import edges for the owner-level pass.
 * @returns The node-id set snapshotted before any database node is added, for
 *   the database phase's existence checks.
 */
export function assembleImportEdges(
    state: AssemblyState,
    options: {
        roomEdges: ReadonlyMap<string, number>;
        packageEdges: ReadonlyMap<string, boolean>;
        fileEdges: readonly FileEdge[];
    },
): Set<string> {
    const { nodes, edges, fileNodeOwner } = state;
    const { roomEdges, packageEdges, fileEdges } = options;
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
    return nodeIds;
}

/**
 * 7e / 7e-i: draws the database nodes. A Drizzle config with no D1 binding
 * already declaring it adds one database node under the edge or package
 * district, with a depends_on edge from the worker or package. Embedded
 * databases (the O11 dependency scan) each land in the district of the first
 * module importing the SDK, and importers get inferred read/write data flow.
 *
 * @param state - The assembly state (`repo`, `nodes`/`edges`, `fileNodeOwner`,
 *   `owningPackage`, `fileText`).
 * @param options - `drizzleConfig` path (or undefined); `edgeHost` the wrangler
 *   edge host (or null); `sourceFiles` in inventory order; `embeddedDatabases`
 *   the detected embedded stores; `nodeIds` the pre-database id snapshot.
 * @returns The one-file-per-owned-source index entries, in sourceFiles order,
 *   for the D17 external-SDK phase that runs next.
 */
export function assembleDatabases(
    state: AssemblyState,
    options: {
        drizzleConfig: string | undefined;
        edgeHost: EdgeHost | null;
        sourceFiles: readonly string[];
        embeddedDatabases: readonly EmbeddedDatabase[];
        nodeIds: ReadonlySet<string>;
    },
): NodeIndexEntry[] {
    const { repo, nodes, edges, fileNodeOwner, owningPackage, fileText } = state;
    const { drizzleConfig, edgeHost, sourceFiles, embeddedDatabases, nodeIds } = options;
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

    // 7e-i. Embedded databases: the node lives in the district of the first
    // module importing the SDK, and importers get inferred reads/writes data
    // flow. One index entry per owned source file, so importer order replays the
    // sourceFiles order.
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
    return ownedFileEntries;
}
