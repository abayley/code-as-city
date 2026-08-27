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
import { addEdge, fileModuleName, linesOf, sdkImporterIds } from "./assembly-helpers.ts";
import type { SpawnedEntry } from "./daemons.ts";
import type { Host } from "./hosts.ts";
import type { NodeIndexEntry } from "./inference.ts";
import type { MapEdge, MapNode } from "./map-types.ts";
import { artefactEntryCandidates, type Package } from "./packages.ts";
import { readJson, readText } from "./read.ts";
import type { RunnableApp } from "./runnable.ts";
import type { ExternalServiceDep } from "./scans.ts";
import { kebab, titleCase } from "./text.ts";

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
