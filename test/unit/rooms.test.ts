import { describe, expect, it } from "vitest";
import type { Package } from "../../src/lib/packages";
import { buildRooms } from "../../src/lib/rooms";

const root: Package = { dir: ".", name: "root", deps: {}, role: "package", id: "root" };

describe("buildRooms", () => {
    it("given a dominant src segment, when rooms are built, then src expands one level deeper", () => {
        const files = ["src/lib/a.ts", "src/lib/b.ts", "src/jobs/c.ts", "src/top.ts", "tools/x.ts"];
        const rooms = buildRooms("/nonexistent", [root], files);
        expect([...rooms.keys()].sort()).toEqual(["root-src", "root-src-jobs", "root-src-lib", "root-tools"]);
        expect(rooms.get("root-src-lib")?.files).toEqual(["src/lib/a.ts", "src/lib/b.ts"]);
        expect(rooms.get("root-src")?.files).toEqual(["src/top.ts"]);
    });

    it("given files at the package root, when rooms are built, then they join the (root) room", () => {
        const rooms = buildRooms("/nonexistent", [root], ["index.ts"]);
        expect(rooms.get("root-root")?.segment).toBe("(root)");
    });

    it("given no dominant segment, when rooms are built, then each first segment is a room", () => {
        const files = ["a/one.ts", "b/two.ts", "c/three.ts"];
        const rooms = buildRooms("/nonexistent", [root], files);
        expect([...rooms.keys()].sort()).toEqual(["root-a", "root-b", "root-c"]);
    });
});
