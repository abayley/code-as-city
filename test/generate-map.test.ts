import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGenerator } from "../src/generate-map";
import { prepareMiniRepo } from "./prepare-mini-repo";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(repoRoot, "vendor", "functionary", "validate-city-map.mjs");
const fixtureRepo = join(repoRoot, "test", "fixtures", "mini-repo");

const tempDirs: string[] = [];

beforeAll(() => {
    prepareMiniRepo();
});

afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Stands in for the fixture's absolute path in the goldens. The generator
 * records where it ran, which differs per clone, so the goldens would
 * otherwise only match on the machine that wrote them.
 */
const FIXTURE_REPOSITORY = "<fixture>";

/**
 * The fields the golden tests read by name. Everything else in the map is
 * still present at runtime and still compared, since the assertions match
 * whole objects; naming only these keeps the reads type-safe without
 * restating the schema.
 */
type GeneratedMap = {
    repository: string;
    generatedAt?: string;
    nodes: Array<{
        id?: string;
        kind?: string;
        label?: string;
        parentId?: string;
        tags?: string[];
        attributes?: Record<string, string> | null;
        sourceRefs?: Array<{ path?: string }>;
    }>;
};

/**
 * Runs the generator against the fixture repo in-process and returns the map
 * with the timestamp removed and the machine-specific repository path
 * normalised. Running in-process (rather than shelling out to `bun`) lets v8
 * instrument the assembly modules the pipeline exercises.
 */
async function generateMap(extraArguments: readonly string[]): Promise<GeneratedMap> {
    const outDir = mkdtempSync(join(tmpdir(), "code-as-city-test-"));
    tempDirs.push(outDir);
    const exitCode = await runGenerator([fixtureRepo, ...extraArguments, "--out-dir", outDir]);
    expect(exitCode, "the generator must exit cleanly").toBe(0);
    const mapPath = join(outDir, "map.json");
    execFileSync("node", [validator, mapPath], { stdio: "pipe" });
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as GeneratedMap;
    delete map.generatedAt;
    expect(map.repository, "the generator must record the repo it mapped").toBe(fixtureRepo);
    map.repository = FIXTURE_REPOSITORY;
    return map;
}

/** Loads a committed golden map. */
function loadGolden(name: string): GeneratedMap {
    return JSON.parse(readFileSync(join(repoRoot, "test", "golden", name), "utf8")) as GeneratedMap;
}

describe("generate-map golden master", async () => {
    it("given the fixture repo, when generating the deployment map, then it matches the golden map", async () => {
        expect(await generateMap([])).toEqual(loadGolden("mini-repo-deployment.json"));
    });

    it("given the fixture repo, when generating the overview map, then it matches the golden map", async () => {
        expect(await generateMap(["--overview"])).toEqual(loadGolden("mini-repo-overview.json"));
    });

    it("given a file reachable only from QA scripts, when generating the overview map, then it is excluded", async () => {
        const map = await generateMap(["--overview"]);
        const scriptNodes = map.nodes.filter((node) =>
            (node.sourceRefs ?? []).some((ref) => ref.path?.startsWith("scripts/")),
        );
        expect(scriptNodes).toEqual([]);
    });

    it("given CI workflows, when generating the deployment map, then only one invoking deploying source is a deployable (D9)", async () => {
        const map = await generateMap([]);
        const ciDeployables = map.nodes.filter((node) => node.id?.startsWith("ci-") && node.kind === "deployable");
        // deploy.yml runs the api service's entry (a deploy root); ci.yml runs a test.
        expect(ciDeployables.map((n) => n.id)).toEqual(["ci-deploy-job"]);
    });

    it("given a dev-only package, when generating, then it leaves the deployment view but stays in the overview (R5)", async () => {
        const deployment = await generateMap([]);
        const overview = await generateMap(["--overview"]);
        const hasE2eDistrict = (map: GeneratedMap) =>
            map.nodes.some((node) => node.id?.startsWith("mini-e2e") && node.label === "@Mini/E2e");
        // @mini/e2e is reached by no host deploy root (only its own e2e script).
        expect(hasE2eDistrict(deployment)).toBe(false);
        expect(hasE2eDistrict(overview)).toBe(true);
    });

    it("given published packages, when generating the deployment map, then each is a tagged deployable (D14)", async () => {
        const map = (await generateMap([])) as GeneratedMap & {
            nodes: Array<{ kind?: string; archetype?: string; tags?: string[]; sourceRefs?: Array<{ path?: string }> }>;
        };
        const deployableAt = (path: string) =>
            map.nodes.find(
                (node) => node.kind === "deployable" && (node.sourceRefs ?? []).some((ref) => ref.path === path),
            );
        // @mini/greeter (bin) -> CLI gateway; @mini/toolkit (main) -> library building; @mini/ext (vscode) -> extension.
        expect(deployableAt("packages/greeter/src")).toMatchObject({ archetype: "gateway", tags: ["cli"] });
        expect(deployableAt("packages/toolkit/src")).toMatchObject({ archetype: "building", tags: ["published"] });
        expect(deployableAt("packages/ext/src")).toMatchObject({ archetype: "gateway", tags: ["extension"] });
    });

    it("given a spawned inventoried entry, when generating, then it is a daemon with a starts edge and variable/test spawns draw nothing (D15)", async () => {
        const map = (await generateMap([])) as GeneratedMap & {
            nodes: Array<{ id?: string; tags?: string[]; sourceRefs?: Array<{ path?: string }> }>;
            edges: Array<{ from?: string; to?: string; label?: string }>;
        };
        const daemons = map.nodes.filter((node) => (node.tags ?? []).includes("daemon"));
        // Only the literal `spawn("./worker.ts")` resolves; the variable spawn and
        // the spawn in cli.test.ts draw nothing.
        expect(daemons).toHaveLength(1);
        const daemon = daemons[0];
        expect(daemon?.sourceRefs?.[0]?.path).toBe("packages/greeter/src/worker.ts");
        const startsEdge = map.edges.find((edge) => edge.label === "starts" && edge.to === daemon?.id);
        expect(startsEdge?.from).toBe("mini-greeter-src");
    });

    it("given two packages sharing a name, when generating the overview, then district ids stay unique", async () => {
        const map = await generateMap(["--overview"]);
        const ids = map.nodes.map((node) => node.id).filter((id): id is string => id !== undefined);
        // @mini/toolkit and packages/toolkit-fork share a name (as ollama-code's
        // root and packages/core do); their districts must not collide.
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("given two packages sharing a name and a src segment, when generating, then their rooms do not merge (HC-015)", async () => {
        const map = await generateMap(["--overview"]);
        const idOf = (path: string) => map.nodes.find((n) => (n.sourceRefs ?? []).some((r) => r.path === path))?.id;
        const parentOf = (path: string) =>
            map.nodes.find((n) => (n.sourceRefs ?? []).some((r) => r.path === path))?.parentId;
        // The two @mini/toolkit packages' files must be distinct nodes in distinct
        // districts, not silently absorbed into one shared room.
        expect(idOf("packages/toolkit/src/clamp.ts")).toBeDefined();
        expect(idOf("packages/toolkit-fork/src/extra.ts")).toBeDefined();
        expect(parentOf("packages/toolkit/src/clamp.ts")).not.toBe(parentOf("packages/toolkit-fork/src/extra.ts"));
    });

    it("given runnable apps, when generating the deployment map, then a server and a web app are gateway deployables (D16)", async () => {
        const map = (await generateMap([])) as GeneratedMap & {
            nodes: Array<{ kind?: string; archetype?: string; tags?: string[]; sourceRefs?: Array<{ path?: string }> }>;
        };
        const deployableAt = (path: string) =>
            map.nodes.find(
                (node) => node.kind === "deployable" && (node.sourceRefs ?? []).some((ref) => ref.path === path),
            );
        // @mini/service starts a server via its `start` script; @mini/web is a
        // web-role package rooted at src/app.tsx.
        expect(deployableAt("packages/service/src")).toMatchObject({
            archetype: "gateway",
            tags: ["server", "listens"],
        });
        expect(deployableAt("packages/web/src")).toMatchObject({ archetype: "gateway", tags: ["app"] });
    });

    it("given barrel files, when generating the overview, then they are labelled by the directory they index, not 'Index' (HC-004)", async () => {
        const map = await generateMap(["--overview"]);
        // packages/toolkit/src/index.ts should read as its directory, not "Index".
        expect(map.nodes.some((node) => node.label === "Index")).toBe(false);
        const barrel = map.nodes.find((node) =>
            (node.sourceRefs ?? []).some((ref) => ref.path === "packages/toolkit/src/index.ts"),
        );
        expect(barrel?.label).toBe("Src");
    });

    it("given src-dominant packages, when generating, then room labels drop the redundant 'Src /' prefix (HC-003)", async () => {
        const deployment = await generateMap([]);
        const hasSrcPrefix = (map: GeneratedMap) => map.nodes.some((node) => node.label?.startsWith("Src / "));
        // packages/api's src/routes, src/jobs, src/migrations read as Routes/Jobs/Migrations.
        expect(hasSrcPrefix(deployment)).toBe(false);
        expect(deployment.nodes.some((node) => node.label === "Routes")).toBe(true);
    });

    it("given a client SDK dependency that is imported, when generating, then it draws an external with a uses edge (D17)", async () => {
        const map = (await generateMap([])) as GeneratedMap & {
            nodes: Array<{ id?: string; kind?: string; label?: string }>;
            edges: Array<{ from?: string; to?: string; label?: string }>;
        };
        // packages/api depends on and imports `openai` (src/ai.ts), but its
        // endpoint falls back to OLLAMA_BASE_URL — so the external resolves to
        // Ollama, folding with @mini/service's own `ollama` SDK external.
        const external = map.nodes.find((node) => node.kind === "external" && node.label === "Ollama");
        expect(external).toBeDefined();
        expect(map.nodes.some((node) => node.label === "OpenAI API")).toBe(false);
        expect(map.edges.some((edge) => edge.label === "uses" && edge.to === external?.id)).toBe(true);
    });

    it("given a compose service with a build context and no dockerfile key, when generating, then the context Dockerfile binds (D3, HC-017)", async () => {
        const map = await generateMap([]);
        // The ml service builds `context: packages/ml` with no dockerfile key,
        // so the default <context>/Dockerfile binds and its COPY sources
        // resolve against that context: the service lands on the host with the
        // context-resolved entry point.
        const ml = map.nodes.find(
            (node) =>
                (node.parentId ?? "").startsWith("host-") &&
                node.attributes?.["entry-point"] === "packages/ml/src/main.ts",
        );
        expect(ml).toBeDefined();
        expect(ml?.attributes?.["service-source"]).toBe("packages/ml/Dockerfile");
    });

    it("given a wrangler entry-dir room, when generating the deployment map, then it deploys to the edge worker (7c-i)", async () => {
        const map = (await generateMap([])) as GeneratedMap & {
            edges: Array<{
                from?: string;
                to?: string;
                kind?: string;
                label?: string;
                sourceRefs?: Array<{ path?: string }>;
            }>;
        };
        // packages/edge/wrangler.toml owns the src/api entry-dir room, which
        // deploys to the worker the config declares.
        const deploys = map.edges.find((edge) => edge.kind === "deploys");
        expect(deploys).toMatchObject({
            from: "mini-edge-src-api",
            to: "edge-worker",
            label: "wrangler deploy",
        });
        expect(deploys?.sourceRefs?.[0]?.path).toBe("packages/edge/wrangler.toml");
    });

    it("given an OTLP producer and a collector host, when generating, then it draws an OTLP export edge (7c-ii)", async () => {
        const deployment = (await generateMap([])) as GeneratedMap & {
            edges: Array<{ from?: string; to?: string; label?: string }>;
        };
        const overview = (await generateMap(["--overview"])) as GeneratedMap & {
            edges: Array<{ from?: string; to?: string; label?: string }>;
        };
        // packages/api/src/telemetry.ts imports @opentelemetry and exports to the
        // otel-collector compose service; the producer feeds the collector in both modes.
        const otlpTo = (map: { edges: Array<{ to?: string; label?: string }> }) =>
            map.edges.find((edge) => edge.label === "OTLP export")?.to;
        expect(otlpTo(deployment)).toMatch(/otel-collector/);
        expect(otlpTo(overview)).toMatch(/otel-collector/);
    });

    it("given a single-word external referenced by an entry, when generating, then it draws a delivers edge (7f-i)", async () => {
        const map = (await generateMap([])) as GeneratedMap & {
            nodes: Array<{ id?: string; kind?: string; label?: string }>;
            edges: Array<{ from?: string; to?: string; kind?: string; label?: string }>;
        };
        // @mini/service imports `ollama`; the Ollama external (a single-word
        // label) is referenced by the service, so it also delivers to it.
        const external = map.nodes.find((node) => node.kind === "external" && node.label === "Ollama");
        expect(external).toBeDefined();
        const delivers = map.edges.find((edge) => edge.label === "delivers" && edge.to === external?.id);
        expect(delivers).toMatchObject({ kind: "data_flow" });
    });

    it("given the fixture repo, when generating twice, then the maps are equal bar the timestamp", async () => {
        expect(await generateMap([])).toEqual(await generateMap([]));
    });

    it("given the committed goldens, when read, then they hold no absolute path from the machine that wrote them", async () => {
        for (const name of ["mini-repo-deployment.json", "mini-repo-overview.json"]) {
            const text = readFileSync(join(repoRoot, "test", "golden", name), "utf8");
            expect(text, `${name} must stay portable across clones`).not.toMatch(/"\/(Users|home)\//);
        }
    });
});
