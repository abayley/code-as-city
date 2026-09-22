import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runGenerator } from "../src/generate-map";
import { prepareMiniRepo } from "./prepare-mini-repo";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(repoRoot, "vendor", "functionary", "validate-city-map.mjs");
const fixtureRepo = join(repoRoot, "test", "fixtures", "mini-repo");

const tempDirs: string[] = [];

beforeAll(() => {
    // The generator prints its `Wrote …` summary on every in-process run;
    // silence it so the two dozen golden runs do not spam the test report.
    vi.spyOn(console, "log").mockImplementation(() => {});
    prepareMiniRepo();
});

afterAll(() => {
    vi.restoreAllMocks();
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
        // scripts/coverage-report.ts is QA-only (the `check:coverage` script)
        // and stays out; scripts/serve.ts is the standalone image's entry, so
        // it stays in.
        expect(scriptNodes.some((node) => (node.sourceRefs ?? []).some((ref) => ref.path === "scripts/serve.ts"))).toBe(
            true,
        );
        expect(
            scriptNodes.some((node) =>
                (node.sourceRefs ?? []).some((ref) => ref.path === "scripts/coverage-report.ts"),
            ),
        ).toBe(false);
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
        // @mini/greeter (bin) -> CLI gateway; @mini/toolkit (main) -> library
        // entry room; @mini/ext (vscode) -> extension. Bare `src/` rooms
        // collapse (HC-003), so each deployable is the entry's own room.
        expect(deployableAt("packages/greeter/src/cli.ts")).toMatchObject({ archetype: "gateway", tags: ["cli"] });
        expect(deployableAt("packages/toolkit/src/index.ts")).toMatchObject({
            archetype: "gateway",
            tags: ["published"],
        });
        expect(deployableAt("packages/ext/src/extension.ts")).toMatchObject({
            archetype: "gateway",
            tags: ["extension"],
        });
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
        expect(startsEdge?.from).toBe("mini-greeter-src-cli");
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
        // web-role package rooted at src/app.tsx. Bare `src/` rooms collapse
        // (HC-003), so the server deployable is its entry room.
        expect(deployableAt("packages/service/src/main.ts")).toMatchObject({
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

    // HC-028: a residual (compose-claimed) package keeps ONE package district
    // holding its rooms and root files, not a district per structured dir with
    // orphaned district-less nodes.
    it("given a residual package, when generating, then its rooms and root files share its package district (HC-028)", async () => {
        const map = await generateMap([]);
        // packages/api is claimed by the compose service, so it is residual;
        // its src/jobs/migrations/routes rooms and root files all parent to the
        // one @Mini/Api district.
        const area = map.nodes.find((node) => node.id === "mini-api-area");
        expect(area).toBeDefined();
        expect(area?.label).toBe("Api");
        expect(map.nodes.some((node) => node.id === "mini-api-src-district")).toBe(false);
        const children = map.nodes.filter((node) => node.parentId === "mini-api-area");
        expect(children.length).toBeGreaterThan(1);
        // The property HC-028 guarantees: no api-sourced node is district-less.
        expect(
            map.nodes.some(
                (node) =>
                    (node.sourceRefs ?? []).some((ref) => ref.path?.startsWith("packages/api/")) &&
                    (node.parentId ?? "") === "",
            ),
        ).toBe(false);
    });

    it("given a published package with a single-file src and loose root files, when generating, then both live in its district (HC-028)", async () => {
        const map = await generateMap([]);
        // packages/plugin (published, one src file, an esbuild.js at the root)
        // is one "Plugin" district holding both, with no district-less stragglers.
        const area = map.nodes.find((node) => node.id === "mini-plugin-area");
        expect(area?.label).toBe("Plugin");
        for (const path of ["packages/plugin/src", "packages/plugin/esbuild.js"]) {
            const owner = map.nodes.find((node) => (node.sourceRefs ?? []).some((ref) => ref.path === path));
            expect(owner?.parentId).toBe("mini-plugin-area");
        }
    });

    it("given a repo with one CLI package, when generating, then its district takes the artefact role (HC-028)", async () => {
        const map = await generateMap([]);
        // @mini/greeter is the fixture's only CLI package; its district reads
        // "CLI" rather than "Greeter".
        const area = map.nodes.find((node) => node.id === "mini-greeter-area");
        expect(area?.label).toBe("CLI");
    });

    it("given a same-named service with a different image across composes, when generating, then both are tagged alternative (HC-020)", async () => {
        const map = await generateMap([]);
        // The canonical compose builds the api service; docker-compose.envoy.yml
        // ships an envoy image under the same name. Both are the variants they
        // are: each keeps its node, tagged "alternative".
        const api = ["host-mini-repo-api", "host-envoy-api"].map((id) => map.nodes.find((node) => node.id === id));
        expect(api).toHaveLength(2);
        for (const node of api) {
            expect(node).toBeDefined();
            expect(node?.tags).toContain("alternative");
        }
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
        // context-resolved entry point (a Python file: packages/ml is a
        // pyproject package, HC-026).
        const ml = map.nodes.find(
            (node) =>
                (node.parentId ?? "").startsWith("host-") &&
                node.attributes?.["entry-point"] === "packages/ml/src/main.py",
        );
        expect(ml).toBeDefined();
        expect(ml?.attributes?.["service-source"]).toBe("packages/ml/Dockerfile");
    });

    it("given a standalone Dockerfile with no compose owner, when generating, then it is a single-service image host (HC-018)", async () => {
        const map = await generateMap([]);
        // The fixture-root Dockerfile is built by no compose service, so it
        // declares its own host: one `app` service bound to the Dockerfile
        // with the ENTRYPOINT-resolved entry.
        const app = map.nodes.find((node) => node.attributes?.["service-source"] === "Dockerfile");
        expect(app).toMatchObject({
            kind: "deployable",
            attributes: { "service-source": "Dockerfile", "entry-point": "scripts/serve.ts" },
        });
        const host = map.nodes.find((node) => node.id === app?.parentId);
        expect(host).toMatchObject({ kind: "scope", archetype: "district" });
    });

    it("given a published package bundled into a host image, when generating, then it is bundled, not a deployable (HC-021)", async () => {
        const map = (await generateMap([])) as GeneratedMap & {
            nodes: Array<{ id?: string; kind?: string; tags?: string[]; sourceRefs?: Array<{ path?: string }> }>;
        };
        // @mini/bundled declares a library entry, but the api image COPYs its
        // lib directory: it is a component of that deployment, so its entry
        // node keeps a `bundled` tag instead of a deployable marking.
        const entry = map.nodes.find((node) =>
            (node.sourceRefs ?? []).some((ref) => ref.path === "packages/bundled/src"),
        );
        expect(entry).toBeDefined();
        expect(entry?.kind).not.toBe("deployable");
        expect(entry?.tags).toContain("bundled");
    });

    it("given a Python package bound to a compose service, when generating, then its files form rooms behind the service (HC-026)", async () => {
        const deployment = await generateMap([]);
        const overview = await generateMap(["--overview"]);
        // packages/ml is a pyproject package (no package.json): its main.py
        // is inventoried, so the ml service's building carries real source.
        const ml = deployment.nodes.find((node) => (node.parentId ?? "").startsWith("host-") && node.label === "Ml");
        expect(ml?.attributes?.["entry-point"]).toBe("packages/ml/src/main.py");
        const module = overview.nodes.find((node) =>
            (node.sourceRefs ?? []).some((ref) => ref.path === "packages/ml/src/main.py"),
        );
        expect(module).toBeDefined();
        // Pytest helpers are test files whatever directory they sit in, so
        // test_helpers.py draws no node in either mode.
        for (const map of [deployment, overview]) {
            expect(
                map.nodes.some((node) =>
                    (node.sourceRefs ?? []).some((ref) => ref.path === "packages/ml/src/test_helpers.py"),
                ),
            ).toBe(false);
        }
    });

    it("given platform site configs, when generating, then each is a site deployable with a deploys edge (D18)", async () => {
        const map = (await generateMap([])) as GeneratedMap & {
            nodes: Array<{
                id?: string;
                kind?: string;
                archetype?: string;
                tags?: string[];
                attributes?: Record<string, string> | null;
                sourceRefs?: Array<{ path?: string }>;
            }>;
            edges: Array<{ from?: string; to?: string; kind?: string; label?: string }>;
        };
        // packages/site ships via netlify.toml; packages/web via vercel.json.
        // Both yield a site district holding a gateway deployable that the
        // owning entry deploys to.
        for (const [config, platform, publish] of [
            ["packages/site/netlify.toml", "netlify", "public"],
            ["packages/web/vercel.json", "vercel", "dist"],
        ] as const) {
            const site = map.nodes.find(
                (node) => node.kind === "deployable" && (node.sourceRefs ?? []).some((ref) => ref.path === config),
            );
            expect(site).toMatchObject({
                archetype: "gateway",
                tags: ["site", platform],
                attributes: { "site-build": "npm run build", "site-publish": publish },
            });
            const deploys = map.edges.find((edge) => edge.to === site?.id && edge.kind === "deploys");
            expect(deploys?.label).toBe(`${platform} deploy`);
        }
    });

    it("given service calls and scrape targets, when generating, then http and scrape edges are drawn (D19/D20)", async () => {
        const map = (await generateMap([])) as GeneratedMap & {
            edges: Array<{
                from?: string;
                to?: string;
                kind?: string;
                evidence?: string;
                label?: string;
                sourceRefs?: Array<{ path?: string }>;
            }>;
        };
        // packages/api posts to the ml service over HTTP (immich shape);
        // prometheus.yml scrapes the api service (declared port corroborates
        // the name against the envoy alternative).
        const http = map.edges.find((edge) => edge.label === "http");
        expect(http).toMatchObject({
            from: "mini-api-src-server",
            to: "host-mini-repo-ml",
            kind: "data_flow",
            evidence: "declared",
        });
        expect(http?.sourceRefs?.[0]?.path).toBe("packages/api/src/server.ts");
        expect(map.edges.find((edge) => edge.label === "scrapes")).toMatchObject({
            from: "host-mini-repo-prometheus",
            to: "host-mini-repo-api",
            kind: "data_flow",
            evidence: "declared",
        });
    });

    it("given a bare src room, when generating, then its children promote to the district and the entry takes the deployable (HC-003)", async () => {
        const map = await generateMap([]);
        // @mini/greeter's loose src/ files read as district rooms directly —
        // no `Src` wrapper between the district and the `Cli` entry, which is
        // itself the CLI deployable.
        expect(map.nodes.some((node) => node.id === "mini-greeter-src")).toBe(false);
        const children = map.nodes.filter(
            (node) => node.parentId === "mini-greeter-area" && !(node.tags ?? []).includes("daemon"),
        );
        expect(children.map((node) => node.label).sort()).toEqual(["Cli", "Top-level files", "Worker"]);
        expect(children.find((node) => node.label === "Cli")?.kind).toBe("deployable");
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
