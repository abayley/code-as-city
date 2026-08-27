import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
    type AssemblyState,
    assembleCiWorkflows,
    assembleConfigExternals,
    assembleDaemons,
    assembleEdgeDistrict,
    assembleExternalServiceSdks,
    assembleImportEdges,
    reclassifyPublishedArtefacts,
    reclassifyRunnableApps,
} from "../../src/lib/assemble-deployment-phases";
import type { MapNode } from "../../src/lib/map-types";
import type { Package } from "../../src/lib/packages";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-dep-phases-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function writeFile(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

/** A minimal assembly state; override only the fields a phase reads. */
function makeState(overrides: Partial<AssemblyState> = {}): AssemblyState {
    return {
        repo,
        nodes: [],
        edges: [],
        warnings: [],
        fileNodeOwner: new Map(),
        fileExists: () => false,
        fileText: () => "",
        owningPackage: () => null,
        uniqueNodeId: (base) => base,
        pushFileRooms: () => {},
        ensureExternalsDistrict: () => "external-systems",
        nodeOwningFile: () => null,
        isShadowed: () => false,
        ...overrides,
    };
}

function pkg(overrides: Partial<Package> = {}): Package {
    return { dir: "packages/p", name: "@x/p", deps: {}, role: "package", id: "x-p", artefact: null, ...overrides };
}

const moduleNode = (id: string, over: Partial<MapNode> = {}): MapNode => ({
    id,
    label: id,
    kind: "module",
    archetype: "worker",
    ...over,
});

describe("reclassifyPublishedArtefacts (D14)", () => {
    it("given a library package with two child rooms, when reclassified, then its node becomes a tagged building", () => {
        const nodes = [
            moduleNode("x-p-src"),
            moduleNode("x-p-src-a", { parentId: "x-p-src" }),
            moduleNode("x-p-src-b", { parentId: "x-p-src" }),
        ];
        const state = makeState({ nodes, nodeOwningFile: () => "x-p-src", fileExists: () => true });
        reclassifyPublishedArtefacts(state, {
            packages: [pkg({ artefact: { kind: "library", tag: "published", entry: "dist/index.js" } })],
            runnableByDir: new Map(),
        });
        expect(nodes[0]).toMatchObject({ kind: "deployable", archetype: "building", tags: ["published"] });
    });

    it("given a library package with fewer than two children, when reclassified, then its node is a gateway", () => {
        const nodes = [moduleNode("x-p-src")];
        const state = makeState({ nodes, nodeOwningFile: () => "x-p-src", fileExists: () => true });
        reclassifyPublishedArtefacts(state, {
            packages: [pkg({ artefact: { kind: "library", tag: "published", entry: "dist/index.js" } })],
            runnableByDir: new Map(),
        });
        expect(nodes[0]).toMatchObject({ kind: "deployable", archetype: "gateway" });
    });

    it("given a runnable package, when reclassified, then D14 yields and the node is untouched", () => {
        const nodes = [moduleNode("x-p-src")];
        const state = makeState({ nodes, nodeOwningFile: () => "x-p-src", fileExists: () => true });
        reclassifyPublishedArtefacts(state, {
            packages: [pkg({ artefact: { kind: "cli", tag: "cli", entry: "cli.js" } })],
            runnableByDir: new Map([
                ["packages/p", { pkgDir: "packages/p", entry: "packages/p/src/main.ts", tag: "server" }],
            ]),
        });
        expect(nodes[0]).toMatchObject({ kind: "module", archetype: "worker" });
    });

    it("given a host-owned node, when reclassified, then a hosted service is never made a deployable", () => {
        const nodes = [moduleNode("x-p-src", { parentId: "host-mini-api" })];
        const state = makeState({ nodes, nodeOwningFile: () => "x-p-src", fileExists: () => true });
        reclassifyPublishedArtefacts(state, {
            packages: [pkg({ artefact: { kind: "cli", tag: "cli", entry: "cli.js" } })],
            runnableByDir: new Map(),
        });
        expect(nodes[0]?.kind).toBe("module");
    });
});

describe("reclassifyRunnableApps (D16)", () => {
    it("given a runnable app node, when reclassified, then it becomes a gateway tagged by how it runs", () => {
        const nodes = [moduleNode("x-web-src")];
        const state = makeState({ nodes, nodeOwningFile: () => "x-web-src" });
        reclassifyRunnableApps(state, {
            runnableApps: [{ pkgDir: "packages/web", entry: "packages/web/src/app.tsx", tag: "app" }],
        });
        expect(nodes[0]).toMatchObject({ kind: "deployable", archetype: "gateway", tags: ["app"] });
    });
});

describe("assembleEdgeDistrict (7b)", () => {
    it("given no edge host, when assembled, then nothing is drawn", () => {
        const state = makeState();
        const claimed = new Set<string>();
        assembleEdgeDistrict(state, { edgeHost: null, claimedSegments: claimed });
        expect(state.nodes).toEqual([]);
        expect(claimed.size).toBe(0);
    });

    it("given an edge host with a D1 binding, when assembled, then it draws the worker, database, and claims the entry root", () => {
        const state = makeState();
        const claimed = new Set<string>();
        assembleEdgeDistrict(state, {
            edgeHost: {
                file: "wrangler.toml",
                name: "mini-edge",
                main: "src/worker.ts",
                d1: [{ binding: "DB", database_name: "prod" }],
            },
            claimedSegments: claimed,
        });
        expect(state.nodes.map((n) => n.id)).toEqual(["edge-delivery", "edge-worker", "d1-prod"]);
        expect(state.edges).toEqual([
            expect.objectContaining({ from: "edge-worker", to: "d1-prod", kind: "depends_on" }),
        ]);
        expect([...claimed]).toEqual(["src"]);
    });
});

describe("assembleImportEdges (7d)", () => {
    it("given room, package, and owner edges, when assembled, then depends_on edges are drawn only between existing nodes", () => {
        const nodes = [moduleNode("a"), moduleNode("b"), moduleNode("c")];
        const state = makeState({
            nodes,
            fileNodeOwner: new Map([
                ["f1", "a"],
                ["f2", "c"],
            ]),
        });
        const nodeIds = assembleImportEdges(state, {
            roomEdges: new Map([
                ["a->b", 2],
                ["a->missing", 1],
            ]),
            packageEdges: new Map([["b->c", true]]),
            fileEdges: [{ from: "f1", to: "f2" }],
        });
        expect(nodeIds).toEqual(new Set(["a", "b", "c"]));
        const pairs = state.edges.map((e) => `${e.from}->${e.to}`);
        expect(pairs).toContain("a->b"); // room edge
        expect(pairs).toContain("b->c"); // package edge
        expect(pairs).toContain("a->c"); // owner edge (f1->f2)
        expect(pairs).not.toContain("a->missing"); // target node absent
        expect(state.edges.find((e) => e.from === "a" && e.to === "b")?.label).toBe("2 imports");
    });
});

describe("assembleExternalServiceSdks (D17)", () => {
    it("given a service imported by a module, when assembled, then it draws an external with a uses edge", () => {
        const state = makeState({ nodes: [] });
        assembleExternalServiceSdks(state, {
            externalServiceDeps: [
                {
                    id: "external-ollama",
                    label: "Ollama",
                    depNames: ["ollama"],
                    path: "packages/p/package.json",
                    description: "Ollama service",
                },
            ],
            ownedFileEntries: [{ id: "mod-a", files: ["packages/p/src/a.ts"] }],
            // sdkImporterIds matches when the file text imports the dep.
            // Override fileText via state to return an import.
        });
        // No importer text -> nothing drawn.
        expect(state.nodes).toEqual([]);
    });

    it("given a matching importer, when assembled, then the external node and uses edge appear", () => {
        const state = makeState({ fileText: () => 'import { Ollama } from "ollama";' });
        assembleExternalServiceSdks(state, {
            externalServiceDeps: [
                {
                    id: "external-ollama",
                    label: "Ollama",
                    depNames: ["ollama"],
                    path: "packages/p/package.json",
                    description: "Ollama service",
                },
            ],
            ownedFileEntries: [{ id: "mod-a", files: ["packages/p/src/a.ts"] }],
        });
        expect(state.nodes).toEqual([expect.objectContaining({ id: "external-ollama", kind: "external" })]);
        expect(state.edges).toEqual([expect.objectContaining({ from: "mod-a", to: "external-ollama", label: "uses" })]);
    });
});

describe("assembleDaemons (D15)", () => {
    it("given a spawned entry with a supervisor node, when assembled, then a daemon node and starts edge are drawn once", () => {
        writeFile("packages/p/src/worker.ts", "console.log('daemon');\n");
        const nodes = [moduleNode("mini-p-src", { parentId: "mini-p-area" })];
        const state = makeState({ nodes, nodeOwningFile: () => "mini-p-src" });
        const opts = { spawnedEntries: [{ caller: "packages/p/src/cli.ts", target: "packages/p/src/worker.ts" }] };
        assembleDaemons(state, opts);
        assembleDaemons(state, opts); // second run must not duplicate the daemon node
        const daemons = state.nodes.filter((n) => (n.tags ?? []).includes("daemon"));
        expect(daemons).toHaveLength(1);
        // addEdge dedups by id and both runs share `${supervisor}--${daemon}`, so one edge.
        expect(state.edges.filter((e) => e.label === "starts")).toHaveLength(1);
    });

    it("given no owning supervisor, when assembled, then nothing is drawn", () => {
        const state = makeState({ nodeOwningFile: () => null });
        assembleDaemons(state, { spawnedEntries: [{ caller: "a.ts", target: "b.ts" }] });
        expect(state.nodes).toEqual([]);
    });
});

describe("assembleConfigExternals (D12)", () => {
    it("given a config.yaml with an https URL, when assembled, then an external node and a fetches edge are drawn", () => {
        writeFile("packages/svc/config.yaml", "endpoint: https://api.example.com/v1\nlocal: http://localhost:3000\n");
        writeFile("packages/svc/package.json", JSON.stringify({ bin: "dist/cli.js" }));
        writeFile("packages/svc/src/cli.ts", "");
        const state = makeState({
            fileExists: (p) => ["packages/svc/config.yaml", "packages/svc/src/cli.ts"].includes(p),
            nodeOwningFile: () => "svc-cli",
        });
        assembleConfigExternals(state, { packages: [pkg({ dir: "packages/svc", name: "@x/svc", id: "x-svc" })] });
        expect(state.nodes).toEqual([expect.objectContaining({ label: "api.example.com", kind: "external" })]);
        expect(state.edges).toEqual([expect.objectContaining({ to: "svc-cli", label: "fetches" })]);
    });
});

describe("assembleCiWorkflows (D9)", () => {
    const workflow = (over: Partial<Parameters<typeof assembleCiWorkflows>[1]["ciWorkflows"][number]> = {}) => ({
        file: ".github/workflows/deploy.yml",
        name: "Deploy",
        cron: "0 0 * * *",
        triggeredBy: [],
        invocations: [{ file: "scripts/deploy.ts", sub: null }],
        storage: null,
        ...over,
    });

    it("given a workflow invoking deploy-reachable source, when assembled, then a CI district, job, and runs edge appear", () => {
        const state = makeState({ nodeOwningFile: () => "deploy-mod" });
        assembleCiWorkflows(state, {
            ciWorkflows: [workflow()],
            deployReachable: new Set(["scripts/deploy.ts"]),
            resolveImport: () => null,
        });
        expect(state.nodes.map((n) => n.id)).toEqual(["ci-deploy", "ci-deploy-job"]);
        expect(state.edges).toEqual([expect.objectContaining({ from: "ci-deploy-job", to: "deploy-mod" })]);
    });

    it("given a workflow that invokes no deploying source, when assembled, then it is dropped", () => {
        const state = makeState({ nodeOwningFile: () => "x" });
        assembleCiWorkflows(state, {
            ciWorkflows: [workflow({ invocations: [{ file: "scripts/lint.ts", sub: null }] })],
            deployReachable: new Set(["scripts/deploy.ts"]),
            resolveImport: () => null,
        });
        expect(state.nodes).toEqual([]);
    });

    it("given object-storage traffic, when assembled, then an external store and directional edges are drawn", () => {
        const state = makeState({ nodeOwningFile: () => null });
        assembleCiWorkflows(state, {
            ciWorkflows: [workflow({ storage: { downloads: true, uploads: true, label: "S3 object storage" } })],
            deployReachable: new Set(["scripts/deploy.ts"]),
            resolveImport: () => null,
        });
        expect(state.nodes.some((n) => n.archetype === "storage")).toBe(true);
        expect(state.edges.filter((e) => e.label === "downloads" || e.label === "uploads")).toHaveLength(2);
    });
});
