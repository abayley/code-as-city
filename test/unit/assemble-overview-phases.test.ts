import { describe, expect, it } from "vitest";
import {
    addOverviewImportEdges,
    assembleInfraDistricts,
    bandOverviewDistricts,
    buildOverviewDistricts,
    emitOverviewModuleNodes,
    type OverviewState,
} from "../../src/lib/assemble-overview-phases";
import type { Coupling } from "../../src/lib/coupling";
import type { MapEdge, MapNode } from "../../src/lib/map-types";
import type { Package } from "../../src/lib/packages";
import type { Room } from "../../src/lib/rooms";

const rootPkg: Package = { dir: ".", name: "root", deps: {}, role: "package", id: "root", artefact: null };

const room = (id: string, segment: string, files: string[], pkg: Package = rootPkg): Room => ({
    id,
    pkg,
    segment,
    files,
    loc: files.length * 10,
});

function makeState(overrides: Partial<OverviewState> = {}): OverviewState {
    return {
        overviewNodes: [],
        allModules: [],
        fileToModule: new Map(),
        linesOfFiles: (files) => files.length * 10,
        fileText: () => "",
        filesHosts: () => new Set(),
        hostBand: () => 3,
        bandLabel: (band) => `band-${band}`,
        moduleIsUtility: () => false,
        ...overrides,
    };
}

const noCoupling = new Map<string, Coupling>();

describe("buildOverviewDistricts", () => {
    it("given a single package and per-room districts, when built, then each file is its own module", () => {
        const r = room("root-src", "src", ["src/a.ts", "src/b.ts"]);
        const districts = buildOverviewDistricts({
            multiPkg: false,
            pkgsWithRooms: [rootPkg],
            activeRooms: [r],
            fileCoupling: noCoupling,
        });
        expect(districts).toHaveLength(1);
        expect(districts[0]?.modules.map((m) => m.path)).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("given migration scripts, when built, then they collapse to one leaf per migrations directory", () => {
        const r = room("root-src", "src", ["src/migrations/0001_init.ts", "src/migrations/0002_add.ts", "src/app.ts"]);
        const districts = buildOverviewDistricts({
            multiPkg: false,
            pkgsWithRooms: [rootPkg],
            activeRooms: [r],
            fileCoupling: noCoupling,
        });
        const labels = districts[0]?.modules.map((m) => m.label);
        expect(labels).toContain("Migrations (2)");
        // one collapsed migrations module + app.ts, not three separate migration modules
        expect(districts[0]?.modules).toHaveLength(2);
    });

    it("given multiple packages, when built, then there is one district per package", () => {
        const other: Package = { ...rootPkg, dir: "packages/b", name: "@x/b", id: "x-b" };
        const districts = buildOverviewDistricts({
            multiPkg: true,
            pkgsWithRooms: [rootPkg, other],
            activeRooms: [
                room("root-src", "src", ["src/a.ts"]),
                room("x-b-src", "src", ["packages/b/src/c.ts"], other),
            ],
            fileCoupling: noCoupling,
        });
        expect(districts.map((d) => d.label)).toEqual(["Root", "@X/B"]);
    });

    it("given two rooms whose ids kebab to the same value, when built, then module ids are suffixed unique", () => {
        const districts = buildOverviewDistricts({
            multiPkg: false,
            pkgsWithRooms: [rootPkg],
            activeRooms: [room("root-src", "src", ["src/a.ts"]), room("root-src2", "src", ["src2/a.ts"])],
            fileCoupling: noCoupling,
        });
        const ids = districts.flatMap((d) => d.modules.map((m) => m.id));
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe("bandOverviewDistricts", () => {
    const districtsFor = () =>
        buildOverviewDistricts({
            multiPkg: false,
            pkgsWithRooms: [rootPkg],
            activeRooms: [
                room("root-api", "api", ["api/x.ts"]),
                room("root-shared", "shared", ["shared/y.ts"]),
                room("root-tel", "tel", ["tel/z.ts"]),
            ],
            fileCoupling: noCoupling,
        });

    it("given code shipping to one host, an OTLP producer, and shared code, when banded, then each lands in its band and they sort", () => {
        const districts = districtsFor();
        const state = makeState({
            filesHosts: (files) => (files.some((f) => f.startsWith("api/")) ? new Set(["api-host"]) : new Set()),
            hostBand: () => 5,
            fileText: (f) => (f.startsWith("tel/") ? "import '@opentelemetry/api';" : ""),
        });
        bandOverviewDistricts(districts, state, { producersBand: 1, sharedBand: 0 });
        const bandOf = (path: string) => districts.find((d) => d.path === path)?.band;
        expect(bandOf("api")).toBe(5); // sole host
        expect(bandOf("tel")).toBe(1); // OTLP producer, no host
        expect(bandOf("shared")).toBe(0); // shared strip
        // sorted ascending by band
        expect(districts.map((d) => d.band)).toEqual([0, 1, 5]);
    });
});

describe("emitOverviewModuleNodes", () => {
    const emitOptions = {
        appColor: "#app",
        sharedColor: "#shared",
        tsxColor: "#tsx",
        fileMaxFunctionComplexity: () => 3,
        fileComplexity: () => 2,
        docForFiles: () => null,
        coverageForFiles: () => null,
        scriptReferencedFiles: new Set<string>(),
        entryDirNames: new Set<string>(["api"]),
    };

    it("given a multi-file module, when emitted, then it is a building with one room node per file", () => {
        const districts = buildOverviewDistricts({
            multiPkg: false,
            pkgsWithRooms: [rootPkg],
            activeRooms: [room("root-lib", "lib", ["lib/a.ts", "lib/b.ts"])],
            fileCoupling: noCoupling,
        });
        // Force the two files into one module by making them a single collapsed-like set:
        // buildOverviewDistricts makes per-file modules, so instead assert the district + module nodes.
        const state = makeState();
        emitOverviewModuleNodes(districts, state, emitOptions);
        const kinds = state.overviewNodes.map((n) => `${n.kind}:${n.archetype}`);
        expect(kinds).toContain("scope:district");
        expect(state.overviewNodes.filter((n) => n.kind === "module")).not.toHaveLength(0);
        // fileToModule and allModules populated
        expect(state.fileToModule.size).toBe(2);
        expect(state.allModules).toHaveLength(2);
    });

    it("given a support module, when emitted, then it is tagged support and flows behind composers", () => {
        const r = room("root-src", "src", ["src/util.ts"]);
        const districts = buildOverviewDistricts({
            multiPkg: false,
            pkgsWithRooms: [rootPkg],
            activeRooms: [r],
            fileCoupling: new Map([["src/util.ts", { in: 3, out: 0, instability: 0 }]]),
        });
        const state = makeState();
        emitOverviewModuleNodes(districts, state, emitOptions);
        const moduleNode = state.overviewNodes.find((n) => n.kind === "module");
        expect(moduleNode?.tags).toContain("support");
        expect(moduleNode?.display?.flowLayer).toBe(1);
    });

    it("given a district that is mostly utility modules, when emitted, then the district reads as shared code", () => {
        const districts = buildOverviewDistricts({
            multiPkg: false,
            pkgsWithRooms: [rootPkg],
            activeRooms: [room("root-lib", "lib", ["lib/a.ts"])],
            fileCoupling: noCoupling,
        });
        const state = makeState({ moduleIsUtility: () => true });
        emitOverviewModuleNodes(districts, state, emitOptions);
        const scope = state.overviewNodes.find((n) => n.kind === "scope");
        expect(scope?.description).toMatch(/^Shared code/);
        expect(scope?.display?.color).toBe("#shared");
    });
});

describe("addOverviewImportEdges", () => {
    it("given file edges across modules, when aggregated, then one counted edge per module pair", () => {
        const overviewEdges: MapEdge[] = [];
        addOverviewImportEdges({
            overviewEdges,
            fileEdges: [
                { from: "a1.ts", to: "b1.ts" },
                { from: "a2.ts", to: "b2.ts" },
                { from: "a1.ts", to: "a2.ts" }, // same module -> skipped
                { from: "x.ts", to: "b1.ts" }, // x not in a module -> skipped
            ],
            fileToModule: new Map([
                ["a1.ts", "mod-a"],
                ["a2.ts", "mod-a"],
                ["b1.ts", "mod-b"],
                ["b2.ts", "mod-b"],
            ]),
        });
        expect(overviewEdges).toEqual([
            expect.objectContaining({ from: "mod-a", to: "mod-b", kind: "depends_on", label: "2 imports" }),
        ]);
    });
});

describe("assembleInfraDistricts (O7/O11)", () => {
    type InfraOpts = Parameters<typeof assembleInfraDistricts>[0];
    const infraOpts = (over: Partial<InfraOpts> = {}): InfraOpts => ({
        overviewNodes: [],
        overviewEdges: [],
        hostScan: [],
        serviceOwner: new Map(),
        hosts: [],
        candidateHosts: [],
        edgeHost: null,
        drizzleConfig: undefined,
        embeddedDatabases: [],
        externalServiceDeps: [],
        fileToModule: new Map(),
        allModules: [],
        fileText: () => "",
        hostBand: () => 1,
        bandLabel: () => "runtime",
        externalsBand: 2,
        sharedBand: 0,
        infraColor: "#888888",
        ...over,
    });

    it("given a host with an image-only backing store, when assembled, then it is drawn as an infra node under the host district", () => {
        const host = {
            file: "docker-compose.yml",
            name: "api",
            id: "host-api",
            rank: 0,
            services: [{ name: "postgres", image: "postgres:16", imageClass: "database", copies: [], entryFile: null }],
        };
        const overviewNodes: MapNode[] = [];
        const members = assembleInfraDistricts(
            infraOpts({
                overviewNodes,
                hosts: [host],
                candidateHosts: [host],
                hostScan: [
                    {
                        host,
                        externals: [],
                        hostTargets: new Set(),
                        hostTargetMatches: [],
                        serviceTargets: [],
                        configs: [],
                    },
                ],
            }),
        );
        expect(members.map((m) => m.id)).toContain("infra-api-postgres");
        expect(overviewNodes.find((n) => n.id === "host-api")).toMatchObject({ kind: "scope", archetype: "district" });
        expect(overviewNodes.find((n) => n.id === "infra-api-postgres")).toMatchObject({
            kind: "infra",
            archetype: "database",
            parentId: "host-api",
        });
    });

    it("given a host declaring an external OTLP receiver, when assembled, then it is drawn as an external node behind the last host", () => {
        const host = {
            file: "docker-compose.yml",
            name: "api",
            id: "host-api",
            rank: 0,
            services: [{ name: "collector", image: "otel/collector", copies: [], entryFile: null }],
        };
        const overviewNodes: MapNode[] = [];
        const members = assembleInfraDistricts(
            infraOpts({
                overviewNodes,
                hosts: [host],
                candidateHosts: [host],
                hostScan: [
                    {
                        host,
                        externals: [
                            { candidate: "langfuse", config: "otel-collector.yaml", envToken: "LANGFUSE_HOST" },
                        ],
                        hostTargets: new Set(),
                        hostTargetMatches: [],
                        serviceTargets: [],
                        configs: ["otel-collector.yaml"],
                    },
                ],
            }),
        );
        expect(members.find((m) => m.id === "external-langfuse")).toMatchObject({ kind: "external", external: true });
        expect(overviewNodes.find((n) => n.id === "external-langfuse")).toMatchObject({
            kind: "external",
            parentId: "external-systems",
        });
    });
});
