import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Package } from "../../src/lib/packages";
import { findPathReassignments } from "../../src/lib/path-references";
import type { Room } from "../../src/lib/rooms";

const repo = mkdtempSync(join(tmpdir(), "code-as-city-pathref-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const cli: Package = { dir: "tools/cli", name: "cli", deps: {}, role: "cli", id: "cli" };
const root: Package = { dir: ".", name: "root", deps: {}, role: "package", id: "root" };
const skillsRoom: Room = { id: "root-skills", pkg: root, segment: "skills", files: ["skills/map/x.ts"], loc: 1 };
const rooms = new Map([[skillsRoom.id, skillsRoom]]);

function writeFile(path: string, content: string): void {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

describe("findPathReassignments", () => {
    it("given a non-import path literal into another area, when scanned, then the room is reassigned", () => {
        writeFile("tools/cli/src/bundle.ts", 'const dir = resolve(root, "../../skills/map");\n');
        const result = findPathReassignments(repo, [root, cli], rooms, ["tools/cli/src/bundle.ts"]);
        expect(result.get("root-skills")).toEqual({ pkg: cli, fromFile: "tools/cli/src/bundle.ts" });
    });

    it("given the same path as an import specifier, when scanned, then it does not reassign", () => {
        writeFile("tools/cli/src/imp.ts", 'import { x } from "../../skills/map";\n');
        expect(findPathReassignments(repo, [root, cli], rooms, ["tools/cli/src/imp.ts"]).size).toBe(0);
    });
});
