import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Package } from "../../src/lib/packages";
import { analyseReachability, stripDevTooling } from "../../src/lib/reachability";
import type { Room } from "../../src/lib/rooms";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-reach-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function writeFile(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

const pkg: Package = { dir: ".", name: "root", deps: {}, role: "package", id: "root", artefact: null };
const makeRoom = (id: string, files: string[]): Room => ({ id, pkg, segment: id, files, loc: 0 });

describe("analyseReachability", () => {
    writeFile(
        "package.json",
        JSON.stringify({
            scripts: {
                "check:coverage": "bun scripts/qa.ts",
                backfill: "bun scripts/backfill.ts",
            },
        }),
    );
    writeFile("scripts/qa.ts", "");
    writeFile("scripts/backfill.ts", "");
    const sourceFiles = ["scripts/qa.ts", "scripts/backfill.ts", "scripts/helper.ts", "src/app.ts"];
    const fileToRoom = new Map(sourceFiles.map((f) => [f, makeRoom("r", [])]));
    const fileEdges = [{ from: "scripts/qa.ts", to: "scripts/helper.ts" }];
    const reachability = analyseReachability(repo, [pkg], [], null, sourceFiles, fileEdges, fileToRoom, []);

    it("given QA-named and operational scripts, when analysed, then only the QA-only chain is dev tooling", () => {
        expect(reachability.isDevToolingFile("scripts/qa.ts")).toBe(true);
        expect(reachability.isDevToolingFile("scripts/helper.ts")).toBe(true);
        expect(reachability.isDevToolingFile("scripts/backfill.ts")).toBe(false);
        expect(reachability.isDevToolingFile("src/app.ts")).toBe(false);
    });

    it("given script commands, when analysed, then script-referenced files are the script roots", () => {
        expect(reachability.scriptReferencedFiles).toEqual(new Set(["scripts/qa.ts", "scripts/backfill.ts"]));
    });
});

describe("stripDevTooling", () => {
    it("given a room of QA files plus unreferenced residue, when stripped, then the room empties with a warning", () => {
        writeFile("scripts2/residue.ts", "const x = 1;");
        const sourceFiles = ["scripts2/qa.ts", "scripts2/residue.ts"];
        writeFile("package.json", JSON.stringify({ scripts: { lint: "bun scripts2/qa.ts" } }));
        const room = makeRoom("scripts2", ["scripts2/qa.ts", "scripts2/residue.ts"]);
        const rooms = new Map([[room.id, room]]);
        const fileToRoom = new Map(sourceFiles.map((f) => [f, room]));
        const fileEdges = [{ from: "scripts2/qa.ts", to: "scripts2/residue.ts" }];
        const reachability = analyseReachability(repo, [pkg], [], null, sourceFiles, fileEdges, fileToRoom, []);
        const warnings = stripDevTooling(repo, rooms, reachability, fileEdges);
        expect(room.files).toEqual([]);
        expect(warnings).toEqual([
            "Dev tooling excluded (reachable only from QA package.json scripts): scripts2 (2 files).",
        ]);
    });
});
