import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
} from "../../src/lib/assemble-deployment-phases";
import type { MapEdge, MapNode } from "../../src/lib/map-types";
import type { Package } from "../../src/lib/packages";
import type { Room } from "../../src/lib/rooms";
import type { EmbeddedDatabase } from "../../src/lib/scans";

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
        scriptReachable: new Set<string>(),
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
            packages: [pkg({ artefact: { kind: "library", tag: "published", entry: "dist/index.js", types: null } })],
            runnableByDir: new Map(),
        });
        expect(nodes[0]).toMatchObject({ kind: "deployable", archetype: "building", tags: ["published"] });
    });

    it("given a library package with fewer than two children, when reclassified, then its node is a gateway", () => {
        const nodes = [moduleNode("x-p-src")];
        const state = makeState({ nodes, nodeOwningFile: () => "x-p-src", fileExists: () => true });
        reclassifyPublishedArtefacts(state, {
            packages: [pkg({ artefact: { kind: "library", tag: "published", entry: "dist/index.js", types: null } })],
            runnableByDir: new Map(),
        });
        expect(nodes[0]).toMatchObject({ kind: "deployable", archetype: "gateway" });
    });

    it("given a runnable package, when reclassified, then D14 yields and the node is untouched", () => {
        const nodes = [moduleNode("x-p-src")];
        const state = makeState({ nodes, nodeOwningFile: () => "x-p-src", fileExists: () => true });
        reclassifyPublishedArtefacts(state, {
            packages: [pkg({ artefact: { kind: "cli", tag: "cli", entry: "cli.js", types: null } })],
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
            packages: [pkg({ artefact: { kind: "cli", tag: "cli", entry: "cli.js", types: null } })],
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

const embeddedDb = (over: Partial<EmbeddedDatabase> = {}): EmbeddedDatabase => ({
    id: "embedded-duckdb",
    label: "DuckDB",
    depName: "duckdb",
    path: "package.json",
    description: "Embedded database.",
    ...over,
});

describe("assembleDatabases (7e)", () => {
    it("given a drizzle config and no D1 binding, when assembled, then a database node hangs under the owner area with a depends_on edge", () => {
        writeFile("drizzle.config.ts", 'export default { dialect: "postgresql" };');
        const state = makeState({
            nodes: [moduleNode("x-p")],
            owningPackage: () => pkg({ id: "x-p" }),
        });
        assembleDatabases(state, {
            drizzleConfig: "drizzle.config.ts",
            edgeHost: null,
            sourceFiles: [],
            embeddedDatabases: [],
            nodeIds: new Set(["x-p-area", "x-p"]),
        });
        expect(state.nodes.find((n) => n.id === "drizzle-database")).toMatchObject({
            archetype: "database",
            parentId: "x-p-area",
            label: "Database (postgresql)",
        });
        expect(state.edges.map((e: MapEdge) => e.id)).toContain("x-p--drizzle-database");
    });

    it("given a D1 binding already in the snapshot, when assembled, then the drizzle database is not re-drawn", () => {
        writeFile("drizzle.config.ts", 'export default { dialect: "postgresql" };');
        const state = makeState({ nodes: [moduleNode("x-p")], owningPackage: () => pkg({ id: "x-p" }) });
        assembleDatabases(state, {
            drizzleConfig: "drizzle.config.ts",
            edgeHost: null,
            sourceFiles: [],
            embeddedDatabases: [],
            nodeIds: new Set(["d1-api", "x-p-area", "x-p"]),
        });
        expect(state.nodes.some((n) => n.id === "drizzle-database")).toBe(false);
    });

    it("given the owner area is absent from the snapshot, when assembled, then no drizzle database is drawn", () => {
        writeFile("drizzle.config.ts", 'export default { dialect: "postgresql" };');
        const state = makeState({ nodes: [moduleNode("x-p")], owningPackage: () => pkg({ id: "x-p" }) });
        assembleDatabases(state, {
            drizzleConfig: "drizzle.config.ts",
            edgeHost: null,
            sourceFiles: [],
            embeddedDatabases: [],
            nodeIds: new Set(["x-p"]),
        });
        expect(state.nodes.some((n) => n.id === "drizzle-database")).toBe(false);
    });

    it("given owned source files, when assembled, then the returned index replays sourceFiles order", () => {
        const state = makeState({
            nodes: [moduleNode("mod-a", { parentId: "d1" }), moduleNode("mod-b")],
            fileNodeOwner: new Map([
                ["src/a.ts", "mod-a"],
                ["src/b.ts", "mod-b"],
            ]),
        });
        const entries = assembleDatabases(state, {
            drizzleConfig: undefined,
            edgeHost: null,
            sourceFiles: ["src/b.ts", "src/a.ts"],
            embeddedDatabases: [],
            nodeIds: new Set(),
        });
        expect(entries.map((e) => e.id)).toEqual(["mod-b", "mod-a"]);
    });

    it("given an embedded database imported by a module, when assembled, then its node lands in the importer's district with a reads/writes edge", () => {
        const state = makeState({
            nodes: [
                moduleNode("d1", { kind: "scope", archetype: "district" }),
                moduleNode("mod-a", { parentId: "d1" }),
            ],
            fileNodeOwner: new Map([["src/a.ts", "mod-a"]]),
            fileText: (file) => (file === "src/a.ts" ? 'import { Database } from "duckdb";' : ""),
        });
        assembleDatabases(state, {
            drizzleConfig: undefined,
            edgeHost: null,
            sourceFiles: ["src/a.ts"],
            embeddedDatabases: [embeddedDb()],
            nodeIds: new Set(),
        });
        expect(state.nodes.find((n) => n.id === "embedded-duckdb")).toMatchObject({
            archetype: "database",
            parentId: "d1",
        });
        expect(state.edges.map((e: MapEdge) => e.id)).toContain("mod-a--embedded-duckdb");
    });
});

describe("assembleStaticClassification (7f)", () => {
    const never = /[^\s\S]/;
    type StaticOpts = Parameters<typeof assembleStaticClassification>[1];
    const staticOpts = (over: Partial<StaticOpts> = {}): StaticOpts => ({
        campusFileSets: [],
        promotedNodes: [],
        fileMaxFunctionComplexity: () => 1,
        coverageForFiles: () => null,
        fileDocSummary: () => null,
        docForFiles: () => null,
        dbWritePattern: never,
        dbReadPattern: never,
        ...over,
    });

    it("given a classification set with files, when classified, then the node gains loc/complexity metrics and a footprint", () => {
        // Two content lines plus the trailing newline: linesOf counts split("\n") = 3.
        writeFile("svc/main.ts", "const a = 1;\nconst b = 2;\n");
        const state = makeState({ nodes: [moduleNode("svc")] });
        assembleStaticClassification(
            state,
            staticOpts({ campusFileSets: [{ id: "svc", files: ["svc/main.ts"] }], fileMaxFunctionComplexity: () => 7 }),
        );
        const node = state.nodes.find((n) => n.id === "svc");
        expect(node?.metrics?.complexity).toBe(7);
        expect(node?.metrics?.loc).toBe(3);
        expect(node?.display?.size).toHaveLength(3);
    });

    it("given a coverage number, when classified, then it lands in metrics", () => {
        writeFile("svc/main.ts", "const a = 1;\n");
        const state = makeState({ nodes: [moduleNode("svc")] });
        assembleStaticClassification(
            state,
            staticOpts({ campusFileSets: [{ id: "svc", files: ["svc/main.ts"] }], coverageForFiles: () => 0.42 }),
        );
        expect(state.nodes.find((n) => n.id === "svc")?.metrics?.coverage).toBe(0.42);
    });

    it("given null coverage, when classified, then the coverage metric is omitted", () => {
        writeFile("svc/main.ts", "const a = 1;\n");
        const state = makeState({ nodes: [moduleNode("svc")] });
        assembleStaticClassification(
            state,
            staticOpts({ campusFileSets: [{ id: "svc", files: ["svc/main.ts"] }], coverageForFiles: () => null }),
        );
        expect(state.nodes.find((n) => n.id === "svc")?.metrics).not.toHaveProperty("coverage");
    });

    it("given a TSDoc summary, when classified, then it leads the node description", () => {
        writeFile("svc/main.ts", "const a = 1;\n");
        const state = makeState({ nodes: [moduleNode("svc", { description: "Existing." })] });
        assembleStaticClassification(
            state,
            staticOpts({
                campusFileSets: [{ id: "svc", files: ["svc/main.ts"] }],
                docForFiles: () => "Serves the API.",
            }),
        );
        expect(state.nodes.find((n) => n.id === "svc")?.description).toBe("Serves the API.\n\nExisting.");
    });

    it("given source that listens and calls out, when classified, then the node is tagged listens and http-client", () => {
        writeFile("svc/main.ts", "server.listen(3000);\nawait fetch('https://x');\n");
        const state = makeState({ nodes: [moduleNode("svc")] });
        assembleStaticClassification(state, staticOpts({ campusFileSets: [{ id: "svc", files: ["svc/main.ts"] }] }));
        expect(state.nodes.find((n) => n.id === "svc")?.tags).toEqual(
            expect.arrayContaining(["listens", "http-client"]),
        );
    });

    it("given a promoted node, when classified, then it is sized alongside the campus sets", () => {
        writeFile("pkg/index.ts", "const a = 1;\n");
        const state = makeState({ nodes: [moduleNode("x-p")] });
        assembleStaticClassification(state, staticOpts({ promotedNodes: [{ id: "x-p", files: ["pkg/index.ts"] }] }));
        expect(state.nodes.find((n) => n.id === "x-p")?.display?.size).toHaveLength(3);
    });
});

describe("assemblePackageDistricts (7c)", () => {
    type PkgOpts = Parameters<typeof assemblePackageDistricts>[1];
    const pkgOpts = (over: Partial<PkgOpts> = {}): PkgOpts => ({
        packages: [],
        rooms: new Map(),
        claimedSegments: new Set(),
        serviceClaimedDirs: new Set(),
        isUtilityRoom: () => false,
        pathReassignments: new Map(),
        roomCoupling: new Map(),
        fileCoupling: new Map(),
        entryDirNames: new Set(),
        deployReachable: new Set(),
        scriptReachable: new Set(),
        hostDeployReachable: new Set(),
        hasHostDeployShape: false,
        runnableByDir: new Map(),
        hosts: [],
        roomEdges: new Map(),
        fileToRoom: new Map(),
        modulesAsBuildings: false,
        edgeHost: null,
        ...over,
    });
    const room = (over: Partial<Room> = {}): Room => ({
        id: "x-p-examples",
        pkg: pkg(),
        segment: "examples",
        files: ["examples/a.ts"],
        loc: 1,
        ...over,
    });

    it("given an unreferenced, undeployed area, when assembled, then it is dropped with an orphan warning", () => {
        const state = makeState();
        const p = pkg();
        assemblePackageDistricts(
            state,
            pkgOpts({ packages: [p], rooms: new Map([["x-p-examples", room({ pkg: p })]]) }),
        );
        expect(state.warnings.some((w) => w.startsWith("Orphan area excluded"))).toBe(true);
        expect(state.nodes.some((n) => n.id === "x-p-area")).toBe(false);
    });

    it("given a real deployment shape that reaches no host root, when assembled, then a dev-only package is excluded with a warning", () => {
        const state = makeState();
        const p = pkg();
        const src = room({ id: "x-p-src", segment: "src", files: ["src/a.ts"], pkg: p });
        assemblePackageDistricts(
            state,
            // entryDirNames spares it from the orphan rule; R5 then strips it as dev-only.
            pkgOpts({
                packages: [p],
                rooms: new Map([["x-p-src", src]]),
                entryDirNames: new Set(["src"]),
                hasHostDeployShape: true,
            }),
        );
        expect(state.warnings.some((w) => w.startsWith("Dev-only package excluded"))).toBe(true);
        expect(state.nodes.some((n) => n.id === "x-p-area")).toBe(false);
    });

    it("given a package a host deploy root reaches, when assembled, then its area scope district is drawn", () => {
        const state = makeState();
        const p = pkg();
        const src = room({ id: "x-p-src", segment: "src", files: ["src/a.ts"], pkg: p });
        assemblePackageDistricts(
            state,
            pkgOpts({
                packages: [p],
                rooms: new Map([["x-p-src", src]]),
                entryDirNames: new Set(["src"]),
                hasHostDeployShape: true,
                hostDeployReachable: new Set(["src/a.ts"]),
            }),
        );
        expect(state.nodes.find((n) => n.id === "x-p-area")).toMatchObject({ kind: "scope", archetype: "district" });
    });
});

describe("assembleHostDistricts (7a)", () => {
    type HostOpts = Parameters<typeof assembleHostDistricts>[1];
    type Hosts = HostOpts["hosts"];
    const hostOpts = (over: Partial<HostOpts> = {}): HostOpts => ({
        hosts: [],
        hostLayer: new Map(),
        candidateHosts: [],
        serviceDependsOn: new Map(),
        hostScan: [],
        rooms: new Map(),
        sourceFiles: [],
        fileToRoom: new Map(),
        isUtilityRoom: () => false,
        fileEdges: [],
        hostLayerBase: 0,
        claimedSegments: new Set(),
        serviceClaimedDirs: new Set(),
        campusFileSets: [],
        ...over,
    });

    it("given a host with an image-only service, when assembled, then a district scope and an infra service node are drawn", () => {
        const state = makeState();
        const hosts: Hosts = [
            {
                file: "docker-compose.yml",
                name: "api",
                id: "host-api",
                rank: 0,
                services: [{ name: "cache", image: "redis", copies: [], entryFile: null }],
            },
        ];
        assembleHostDistricts(state, hostOpts({ hosts }));
        expect(state.nodes.find((n) => n.id === "host-api")).toMatchObject({ kind: "scope", archetype: "district" });
        expect(state.nodes.find((n) => n.id === "host-api-cache")).toMatchObject({
            kind: "infra",
            parentId: "host-api",
        });
    });

    // A host whose one dockerfile service copies in a source dir holding two files.
    const dockerfileHosts = (): Hosts => [
        {
            file: "docker-compose.yml",
            name: "api",
            id: "host-api",
            rank: 0,
            services: [
                {
                    name: "web",
                    dockerfile: "web/Dockerfile",
                    copies: ["packages/api/src"],
                    entryFile: "packages/api/src/main.ts",
                    hasPorts: true,
                },
            ],
        },
    ];
    const dockerfileSources = ["packages/api/src/a.ts", "packages/api/src/b.ts"];

    it("given a dockerfile service copying a source dir, when assembled, then it claims the dir into both handoff sets", () => {
        const state = makeState();
        const claimedSegments = new Set<string>();
        const serviceClaimedDirs = new Set<string>();
        assembleHostDistricts(
            state,
            hostOpts({ hosts: dockerfileHosts(), sourceFiles: dockerfileSources, claimedSegments, serviceClaimedDirs }),
        );
        expect([...claimedSegments]).toContain("packages/api/src");
        expect([...serviceClaimedDirs]).toContain("packages/api/src");
    });

    it("given a dockerfile service, when assembled, then it records the campus file set and file ownership", () => {
        const state = makeState();
        const campusFileSets: HostOpts["campusFileSets"] = [];
        assembleHostDistricts(
            state,
            hostOpts({ hosts: dockerfileHosts(), sourceFiles: dockerfileSources, campusFileSets }),
        );
        expect(campusFileSets).toEqual([
            { id: "host-api-web", files: dockerfileSources, entryFile: "packages/api/src/main.ts" },
        ]);
        expect(state.fileNodeOwner.get("packages/api/src/a.ts")).toBe("host-api-web");
    });

    it("given a dockerfile service, when assembled, then its node is a deployable under the host district", () => {
        const state = makeState();
        assembleHostDistricts(state, hostOpts({ hosts: dockerfileHosts(), sourceFiles: dockerfileSources }));
        expect(state.nodes.find((n) => n.id === "host-api-web")).toMatchObject({
            kind: "deployable",
            parentId: "host-api",
        });
    });
});
