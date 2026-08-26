import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    addEdge,
    escapeRegex,
    externalReferencePattern,
    fileModuleName,
    footprintFor,
    linesOf,
    mermaidId,
    roomLabel,
    sdkImportPattern,
    splitEdgeKey,
    uniqueId,
} from "../../src/lib/assembly-helpers";
import type { MapEdge } from "../../src/lib/map-types";

const edge = (id: string): MapEdge => ({ id, from: "a", to: "b", kind: "depends_on", evidence: "declared" });

describe("addEdge", () => {
    it("given an empty list, when an edge is added, then it is appended", () => {
        const edges: MapEdge[] = [];
        addEdge(edges, edge("a--b"));
        expect(edges).toHaveLength(1);
    });

    it("given an edge with the same id, when added again, then the duplicate is dropped", () => {
        const edges: MapEdge[] = [edge("a--b")];
        addEdge(edges, { ...edge("a--b"), label: "second" });
        expect(edges).toHaveLength(1);
        expect(edges[0]?.label).toBeUndefined();
    });
});

describe("splitEdgeKey", () => {
    it("given an a->b key, when split, then returns both endpoints", () => {
        expect(splitEdgeKey("left->right")).toEqual(["left", "right"]);
    });

    it("given a key without the arrow, when split, then throws", () => {
        expect(() => splitEdgeKey("no-arrow")).toThrow("Malformed edge key: no-arrow");
    });
});

describe("linesOf", () => {
    it("given files in a repo, when summed, then returns the total line count", () => {
        const repo = mkdtempSync(join(tmpdir(), "assembly-helpers-"));
        writeFileSync(join(repo, "one.ts"), "a\nb\nc");
        writeFileSync(join(repo, "two.ts"), "d\n");
        expect(linesOf(repo, ["one.ts", "two.ts"])).toBe(5);
    });
});

describe("roomLabel", () => {
    it("given the (root) segment, when labelled, then reads Top-level files", () => {
        expect(roomLabel("(root)")).toBe("Top-level files");
    });

    it("given a nested segment, when labelled, then title-cases the path parts", () => {
        expect(roomLabel("src/lib")).toBe("Src / Lib");
    });
});

describe("fileModuleName", () => {
    it("given a source file path, when named, then returns the basename without extension", () => {
        expect(fileModuleName("src/lib/assemble-overview.ts")).toBe("assemble-overview");
    });
});

describe("uniqueId", () => {
    it("given a free base, when resolved, then returns the base unchanged", () => {
        expect(uniqueId("node", () => false)).toBe("node");
    });

    it("given collisions, when resolved, then suffixes from -2 until free", () => {
        const taken = new Set(["node", "node-2"]);
        expect(uniqueId("node", (id) => taken.has(id))).toBe("node-3");
    });
});

describe("mermaidId", () => {
    it("given an id with punctuation, when sanitised, then keeps only word characters", () => {
        expect(mermaidId("a-b.c/d")).toBe("a_b_c_d");
    });
});

describe("footprintFor", () => {
    it("given low complexity, when sized, then clamps to the 0.95 floor", () => {
        expect(footprintFor(0)).toBe(0.95);
    });

    it("given huge complexity, when sized, then clamps to the 2.5 ceiling", () => {
        expect(footprintFor(1000)).toBe(2.5);
    });

    it("given mid complexity, when sized, then follows the sqrt formula", () => {
        expect(footprintFor(4)).toBeCloseTo(1.35);
    });
});

describe("sdkImportPattern", () => {
    it("given a dependency name, when matched, then hits imports and requires of it", () => {
        const pattern = sdkImportPattern("@scope/db.js");
        expect(pattern.test('import { open } from "@scope/db.js";')).toBe(true);
        expect(pattern.test('const db = require("@scope/db.js");')).toBe(true);
        expect(pattern.test('import x from "other";')).toBe(false);
    });

    it("given regex metacharacters in the name, when built, then they are escaped", () => {
        expect(sdkImportPattern("a.b").test('from "axb"')).toBe(false);
    });
});

describe("externalReferencePattern", () => {
    it("given an external name, when matched, then hits SDK imports and env-var prefixes", () => {
        const pattern = externalReferencePattern("langfuse");
        expect(pattern.test('import { Langfuse } from "langfuse-node";')).toBe(true);
        expect(pattern.test("process.env.LANGFUSE_SECRET")).toBe(true);
        expect(pattern.test("unrelated text")).toBe(false);
    });
});

describe("escapeRegex", () => {
    it("given regex metacharacters, when escaped, then the result matches them literally", () => {
        const pattern = new RegExp(escapeRegex("run(a+b)"));
        expect(pattern.test("run(a+b)")).toBe(true);
        expect(pattern.test("runaab")).toBe(false);
    });

    it("given a token with a quantifier, when embedded in a pattern, then it does not throw", () => {
        expect(() => new RegExp(`\\.command\\(['"]${escapeRegex("sync-*")}`)).not.toThrow();
    });

    it("given plain text, when escaped, then it is unchanged", () => {
        expect(escapeRegex("deploy-worker")).toBe("deploy-worker");
    });
});
