/**
 * Deployment-map assembly phases extracted from `assemble-deployment.ts`
 * (section 7). Each function is one heuristic's pass: it takes the accumulators
 * it appends to (or the nodes it reclassifies) plus the narrow slice of context
 * and shared helpers it needs, and mutates them in place, mirroring the pass
 * style of `inference.ts`. The orchestrator in `assemble-deployment.ts` calls
 * them in order. The 7x markers are that file's own section headings; D12-D17
 * are HEURISTICS.md rule IDs.
 */
import { basename, join } from "node:path";
import {
    addEdge,
    escapeRegex,
    fileModuleName,
    footprintFor,
    linesOf,
    sdkImporterIds,
    splitEdgeKey,
} from "./assembly-helpers.ts";
import type { SpawnedEntry } from "./daemons.ts";
import type { Host } from "./hosts.ts";
import {
    inferEmbeddedDatabaseUse,
    inferExternalDelivers,
    inferModuleDataFlows,
    type NodeIndexEntry,
} from "./inference.ts";
import type { FileEdge, MapEdge, MapNode } from "./map-types.ts";
import { artefactEntryCandidates, type Package } from "./packages.ts";
import { readJson, readText } from "./read.ts";
import type { RunnableApp } from "./runnable.ts";
import type { EmbeddedDatabase, ExternalServiceDep } from "./scans.ts";
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
    /** Whether a service name is shadowed by its canonical topology owner (D1). */
    isShadowed: (host: Host, serviceName: string) => boolean;
};

/**
 * 7c-iv / D14: reclassifies each published-artefact package's room into a
 * deployable. A non-private package that declares a bin, a library entry, or a
 * VS Code extension is published; its entry resolves to source via the
 * dist->src convention, and the owning node becomes the deployable — a CLI or
 * extension reads as a gateway, a library as a building (only when it holds the
 * two rooms the validator requires; otherwise a gateway). A runnable app (D16)
 * takes precedence, so its package is skipped here. Mutates matched nodes in
 * place.
 *
 * @param state - The assembly state (`nodes` reclassified in place, plus
 *   `fileExists`/`nodeOwningFile`).
 * @param options - `packages` to scan; `runnableByDir` to yield D16 precedence.
 */
export function reclassifyPublishedArtefacts(
    state: AssemblyState,
    options: { packages: readonly Package[]; runnableByDir: ReadonlyMap<string, RunnableApp> },
): void {
    const { nodes, fileExists, nodeOwningFile } = state;
    const { packages, runnableByDir } = options;
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
    },
): void {
    const { repo, nodes, edges, fileText } = state;
    const {
        campusFileSets,
        promotedNodes,
        fileMaxFunctionComplexity,
        coverageForFiles,
        fileDocSummary,
        docForFiles,
        dbWritePattern,
        dbReadPattern,
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
