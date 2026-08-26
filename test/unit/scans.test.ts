import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Package } from "../../src/lib/packages";
import { createDocScanner, findEmbeddedDatabases, scanCoverage } from "../../src/lib/scans";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-scans-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function writeFile(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

describe("scanCoverage", () => {
    it("given suite summaries, when merged, then the best per-file coverage wins and aggregates weight by lines", () => {
        const entry = (covered: number, total: number, pct: number) => ({ lines: { covered, total, pct } });
        writeFile(
            "coverage/unit/coverage-summary.json",
            JSON.stringify({ total: entry(1, 2, 50), [join(repo, "src/a.ts")]: entry(5, 10, 50) }),
        );
        writeFile(
            "coverage/integration/coverage-summary.json",
            JSON.stringify({ [join(repo, "src/a.ts")]: entry(8, 10, 80), [join(repo, "src/b.ts")]: entry(0, 10, 0) }),
        );
        const { coverageForFiles } = scanCoverage(repo, []);
        expect(coverageForFiles(["src/a.ts"])).toBe(80);
        expect(coverageForFiles(["src/a.ts", "src/b.ts"])).toBe(40);
        expect(coverageForFiles(["src/none.ts"])).toBeNull();
    });
});

describe("createDocScanner", () => {
    it("given a file-level TSDoc block, when summarised, then the first paragraph without tags is returned", () => {
        writeFile(
            "src/doc.ts",
            "// header\n/**\n * Does the thing.\n * Second line.\n *\n * @param x ignored\n */\nexport function f() {}\n",
        );
        const { fileDocSummary } = createDocScanner(repo);
        expect(fileDocSummary("src/doc.ts")).toBe("Does the thing. Second line.");
    });

    it("given a doc block after code that is not on an export, when summarised, then null", () => {
        writeFile("src/mid.ts", "const x = 1;\n/** Not file level. */\nconst y = 2;\n");
        expect(createDocScanner(repo).fileDocSummary("src/mid.ts")).toBeNull();
    });

    it("given multiple files, when picking a doc, then the entry-like filename wins", () => {
        writeFile("src/util.ts", "/** Util doc. */\nexport const u = 1;\n");
        writeFile("src/thing-cli.ts", "/** Cli doc. */\nexport const c = 1;\n");
        expect(createDocScanner(repo).docForFiles(["src/util.ts", "src/thing-cli.ts"])).toBe("Cli doc.");
    });
});

describe("findEmbeddedDatabases", () => {
    it("given manifests declaring the same store, when found, then one entry per dependency repo-wide", () => {
        const pkg = (dir: string, deps: Record<string, string>): Package => ({
            dir,
            name: dir,
            deps,
            role: "package",
            id: dir.replace(/\//g, "-"),
            artefact: null,
        });
        const result = findEmbeddedDatabases([
            pkg(".", { "better-sqlite3": "1" }),
            pkg("packages/a", { "better-sqlite3": "1", "@lancedb/lancedb": "2" }),
        ]);
        expect(result.map((db) => [db.id, db.label, db.path])).toEqual([
            ["infra-better-sqlite3", "SQLite database", "package.json"],
            ["infra-lancedb-lancedb", "LanceDB vector database", "packages/a/package.json"],
        ]);
    });
});
