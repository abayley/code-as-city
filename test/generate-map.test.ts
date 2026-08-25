import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareMiniRepo } from "./prepare-mini-repo";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = join(repoRoot, "src", "generate-map.mjs");
const validator = join(repoRoot, "vendor", "functionary", "validate-city-map.mjs");
const fixtureRepo = join(repoRoot, "test", "fixtures", "mini-repo");

const tempDirs: string[] = [];

beforeAll(() => {
    prepareMiniRepo();
});

afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Runs the generator against the fixture repo and returns the map with the timestamp removed. */
function generateMap(extraArguments: readonly string[]): Record<string, unknown> {
    const outDir = mkdtempSync(join(tmpdir(), "code-as-city-test-"));
    tempDirs.push(outDir);
    execFileSync("node", [generator, fixtureRepo, ...extraArguments, "--out-dir", outDir], { stdio: "pipe" });
    const mapPath = join(outDir, "map.json");
    execFileSync("node", [validator, mapPath], { stdio: "pipe" });
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, unknown> & { generatedAt?: string };
    delete map.generatedAt;
    return map;
}

/** Loads a committed golden map. */
function loadGolden(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(repoRoot, "test", "golden", name), "utf8")) as Record<string, unknown>;
}

describe("generate-map golden master", () => {
    it("given the fixture repo, when generating the deployment map, then it matches the golden map", () => {
        expect(generateMap([])).toEqual(loadGolden("mini-repo-deployment.json"));
    });

    it("given the fixture repo, when generating the overview map, then it matches the golden map", () => {
        expect(generateMap(["--overview"])).toEqual(loadGolden("mini-repo-overview.json"));
    });

    it("given a file reachable only from QA scripts, when generating the overview map, then it is excluded", () => {
        const map = generateMap(["--overview"]);
        const nodes = map["nodes"] as Array<{ sourceRefs?: Array<{ path?: string }> }>;
        const scriptNodes = nodes.filter((node) =>
            (node.sourceRefs ?? []).some((ref) => ref.path?.startsWith("scripts/")),
        );
        expect(scriptNodes).toEqual([]);
    });

    it("given the fixture repo, when generating twice, then output is byte-identical bar the timestamp", () => {
        expect(generateMap([])).toEqual(generateMap([]));
    });
});
