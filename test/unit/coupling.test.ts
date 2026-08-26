import { describe, expect, it } from "vitest";
import { analyseCoupling } from "../../src/lib/coupling";
import type { Package } from "../../src/lib/packages";
import type { Room } from "../../src/lib/rooms";

const pkg: Package = { dir: ".", name: "root", deps: {}, role: "package", id: "root", artefact: null };
const room = (id: string, files: string[]): [string, Room] => [id, { id, pkg, segment: id, files, loc: 0 }];

describe("analyseCoupling file coupling", () => {
    it("given repeated file edges, when analysed, then fan-in/out are distinct-neighbour counts", () => {
        const { fileCoupling } = analyseCoupling(
            [
                { from: "a", to: "lib" },
                { from: "b", to: "lib" },
                { from: "a", to: "lib" },
            ],
            new Map(),
            new Map(),
        );
        expect(fileCoupling.get("lib")).toEqual({ in: 2, out: 0, instability: 0 });
        expect(fileCoupling.get("a")).toEqual({ in: 0, out: 1, instability: 1 });
    });
});

describe("analyseCoupling", () => {
    it("given a room with fan-in 3 and no outgoing edges, when analysed, then it is eliminated", () => {
        const roomEdges = new Map([
            ["a->lib", 1],
            ["b->lib", 1],
            ["c->lib", 1],
        ]);
        const rooms = new Map([room("lib", ["lib/l.ts"]), room("a", []), room("b", []), room("c", [])]);
        const analysis = analyseCoupling([], roomEdges, rooms);
        expect(analysis.isUtilityRoom("lib")).toBe(true);
        expect(analysis.eliminatedRooms.map((r) => r.id)).toEqual(["lib"]);
    });

    it("given a mid-band anchor file in the room, when analysed, then the room is retained", () => {
        const fileEdges = [
            { from: "x1.ts", to: "lib/anchor.ts" },
            { from: "x2.ts", to: "lib/anchor.ts" },
            { from: "x3.ts", to: "lib/anchor.ts" },
            { from: "lib/anchor.ts", to: "y1.ts" },
            { from: "lib/anchor.ts", to: "y2.ts" },
        ];
        const roomEdges = new Map([
            ["a->lib", 1],
            ["b->lib", 1],
            ["c->lib", 1],
        ]);
        const rooms = new Map([room("lib", ["lib/anchor.ts"]), room("a", []), room("b", []), room("c", [])]);
        const analysis = analyseCoupling(fileEdges, roomEdges, rooms);
        expect(analysis.isMidFile("lib/anchor.ts")).toBe(true);
        expect(analysis.isUtilityRoom("lib")).toBe(false);
        expect(analysis.eliminatedRooms).toEqual([]);
    });
});
