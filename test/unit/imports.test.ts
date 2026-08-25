import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanImports } from "../../src/lib/imports";
import { discoverPackages } from "../../src/lib/packages";
import { buildRooms } from "../../src/lib/rooms";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-imp-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function writeFile(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

describe("scanImports", () => {
    writeFile("package.json", '{"name": "root"}');
    writeFile("packages/other/package.json", '{"name": "@x/other"}');
    writeFile("src/a.ts", 'import { b } from "./nested/b.js";\nimport "@x/other";\nimport "lodash";\n');
    writeFile("src/nested/b.ts", 'import "node:path";\n');
    writeFile("packages/other/src/o.ts", "export const o = 1;\n");
    const sourceFiles = ["src/a.ts", "src/nested/b.ts", "packages/other/src/o.ts"];
    const packages = discoverPackages(repo, [".", "packages/other"]);
    const scan = scanImports(repo, packages, buildRooms(repo, packages, sourceFiles), sourceFiles);

    it("given a relative .js specifier, when scanned, then it resolves to the .ts file on disk", () => {
        expect(scan.fileEdges).toEqual([{ from: "src/a.ts", to: "src/nested/b.ts" }]);
    });

    it("given a local package name, when scanned, then a cross-package edge is recorded", () => {
        expect([...scan.packageEdges.keys()]).toEqual(["root->x-other"]);
    });

    it("given unresolvable bare specifiers, when scanned, then they are recorded per importing package", () => {
        expect([...scan.bareImports.keys()].sort()).toEqual(["lodash", "node:path"]);
        expect(scan.bareImports.get("lodash")).toEqual(new Set(["root"]));
    });

    it("given cross-room file edges, when aggregated, then room edges carry counts", () => {
        expect([...scan.roomEdges.entries()]).toEqual([["root-src->root-src-nested", 1]]);
    });
});
