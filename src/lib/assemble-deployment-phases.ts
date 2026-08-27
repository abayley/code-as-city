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
import type { NodeIndexEntry } from "./inference.ts";
import type { MapEdge, MapNode } from "./map-types.ts";
import { artefactEntryCandidates, type Package } from "./packages.ts";
import { readJson, readText } from "./read.ts";
import type { RunnableApp } from "./runnable.ts";
import type { ExternalServiceDep } from "./scans.ts";
import { kebab, titleCase } from "./text.ts";

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
 * @param options - `packages` to scan; `runnableByDir` to yield D16 precedence;
 *   `nodes` the emitted nodes to reclassify; `fileExists` to resolve the
 *   artefact entry; `nodeOwningFile` to find the entry's node.
 */
export function reclassifyPublishedArtefacts(options: {
    packages: readonly Package[];
    runnableByDir: ReadonlyMap<string, RunnableApp>;
    nodes: MapNode[];
    fileExists: (p: string) => boolean;
    nodeOwningFile: (file: string) => string | null;
}): void {
    const { packages, runnableByDir, nodes, fileExists, nodeOwningFile } = options;
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
 * @param options - `runnableApps` the detected apps; `nodes` to reclassify;
 *   `nodeOwningFile` to find each app entry's node.
 */
export function reclassifyRunnableApps(options: {
    runnableApps: readonly RunnableApp[];
    nodes: MapNode[];
    nodeOwningFile: (file: string) => string | null;
}): void {
    const { runnableApps, nodes, nodeOwningFile } = options;
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
 * @param options - `externalServiceDeps` the detected client-SDK services;
 *   `ownedFileEntries` the file-to-node index the importers are matched
 *   against; `fileText` to read source for SDK imports; `nodes`/`edges` the
 *   accumulators; `ensureExternalsDistrict` to parent new external nodes.
 */
export function assembleExternalServiceSdks(options: {
    externalServiceDeps: readonly ExternalServiceDep[];
    ownedFileEntries: readonly NodeIndexEntry[];
    fileText: (file: string) => string;
    nodes: MapNode[];
    edges: MapEdge[];
    ensureExternalsDistrict: () => string;
}): void {
    const { externalServiceDeps, ownedFileEntries, fileText, nodes, edges, ensureExternalsDistrict } = options;
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
 * @param options - `repo`/`packages` to locate each config and its bin entry;
 *   `nodes`/`edges` the accumulators; `fileExists` to probe config and entry
 *   files; `nodeOwningFile` to attribute the CLI entry to its node;
 *   `ensureExternalsDistrict` to parent new external nodes.
 */
export function assembleConfigExternals(options: {
    repo: string;
    packages: readonly Package[];
    nodes: MapNode[];
    edges: MapEdge[];
    fileExists: (p: string) => boolean;
    nodeOwningFile: (file: string) => string | null;
    ensureExternalsDistrict: () => string;
}): void {
    const { repo, packages, nodes, edges, fileExists, nodeOwningFile, ensureExternalsDistrict } = options;
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
 * @param options - `repo` for line counts; `spawnedEntries` the caller/target
 *   spawn pairs; `nodes`/`edges` the accumulators to append to; `nodeOwningFile`
 *   to attribute a spawning file to its emitted supervisor node.
 */
export function assembleDaemons(options: {
    repo: string;
    spawnedEntries: readonly SpawnedEntry[];
    nodes: MapNode[];
    edges: MapEdge[];
    nodeOwningFile: (file: string) => string | null;
}): void {
    const { repo, spawnedEntries, nodes, edges, nodeOwningFile } = options;
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
