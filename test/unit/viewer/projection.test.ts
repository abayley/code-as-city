// Characterisation tests for the campus projection: collapsing the full
// node/edge graph onto the currently visible (campus) level. Pure module (its
// runtime imports are type-only), so this runs in the node project — a plain
// `.test.ts` under test/unit/viewer lands there (see flow-layout.test.ts).
import { describe, expect, it } from "vitest";
import type { CityEdge, CityMap, CityNode } from "../../../viewer/lib/city-map";
import { closestVisibleAncestor, projectToVisible } from "../../../viewer/lib/projection";

/** Builds a CityNode with quiet defaults so a fixture spells out only what it exercises. */
function node(id: string, overrides: Partial<CityNode> = {}): CityNode {
    return {
        id,
        label: overrides.label ?? id,
        kind: overrides.kind ?? "module",
        archetype: overrides.archetype ?? "building",
        ...overrides,
    };
}

/** Builds a CityEdge between two node ids. */
function edge(id: string, from: string, to: string, overrides: Partial<CityEdge> = {}): CityEdge {
    return { id, from, to, kind: overrides.kind ?? "calls", evidence: overrides.evidence ?? "declared", ...overrides };
}

/** A small map: one district scope, two campus structures (api has a room), one room. */
function map(overrides: Partial<CityMap> = {}): CityMap {
    return {
        schemaVersion: 1,
        id: "m",
        name: "M",
        nodes: overrides.nodes ?? [
            node("d1", { kind: "scope", archetype: "district" }),
            node("api", { parentId: "d1", archetype: "gateway" }),
            node("web"),
            node("api/r1", { parentId: "api", archetype: "room" }),
        ],
        edges: overrides.edges ?? [],
    };
}

describe("closestVisibleAncestor", () => {
    it("projects a hidden room onto its visible campus building", () => {
        const projection = projectToVisible(map());
        expect(closestVisibleAncestor("api/r1", { nodeById: projection.nodeById, visibleIds: projection.ids })).toBe(
            "api",
        );
    });

    it("returns null when the whole ancestor chain is hidden", () => {
        const nodeById = new Map<string, CityNode>([
            ["hidden", node("hidden", { archetype: "room" })],
            ["leaf", node("leaf", { archetype: "room", parentId: "hidden" })],
        ]);
        expect(closestVisibleAncestor("leaf", { nodeById, visibleIds: new Set<string>() })).toBeNull();
    });
});

describe("projectToVisible — campus nodes", () => {
    it("keeps non-scope nodes whose parent is a scope or missing, and drops rooms and scopes", () => {
        const projection = projectToVisible(map());
        expect(projection.nodes.map((n) => n.id).sort()).toEqual(["api", "web"]);
        expect([...projection.ids].sort()).toEqual(["api", "web"]);
    });

    it("indexes every node by id, rooms included, for ancestor walks", () => {
        const projection = projectToVisible(map());
        expect(projection.nodeById.get("api/r1")?.id).toBe("api/r1");
    });
});

describe("projectToVisible — campus edges", () => {
    it("projects edges to campus level and drops those that collapse to a self-loop", () => {
        const projection = projectToVisible(
            map({
                nodes: [
                    node("d1", { kind: "scope", archetype: "district" }),
                    node("api", { parentId: "d1", archetype: "gateway" }),
                    node("web"),
                    node("api/r1", { parentId: "api", archetype: "room" }),
                ],
                edges: [edge("e1", "api/r1", "web"), edge("e2", "api/r1", "api")],
            }),
        );
        // api/r1 projects to api: e1 becomes api->web; e2 becomes api->api (dropped).
        expect(projection.edges.map((e) => ({ id: e.id, from: e.from, to: e.to }))).toEqual([
            { id: "campus:api->web", from: "api", to: "web" },
        ]);
    });

    it("dedupes a campus pair to the highest-evidence edge", () => {
        const projection = projectToVisible(
            map({
                nodes: [
                    node("d1", { kind: "scope", archetype: "district" }),
                    node("api", { parentId: "d1" }),
                    node("web"),
                ],
                edges: [
                    edge("declared", "api", "web", { evidence: "declared" }),
                    edge("observed", "api", "web", { evidence: "observed" }),
                    edge("inferred", "api", "web", { evidence: "inferred" }),
                ],
            }),
        );
        expect(projection.edges).toHaveLength(1);
        expect(projection.edges[0]?.evidence).toBe("observed");
    });

    it("exposes ancestorOf bound to the projection", () => {
        const projection = projectToVisible(map());
        expect(projection.ancestorOf("api/r1")).toBe("api");
        expect(projection.ancestorOf("web")).toBe("web");
    });
});

describe("projectToVisible — edgesTouching", () => {
    const projection = () =>
        projectToVisible(
            map({
                nodes: [
                    node("d1", { kind: "scope", archetype: "district" }),
                    node("api", { parentId: "d1" }),
                    node("web"),
                    node("db", { archetype: "database" }),
                ],
                edges: [edge("e1", "api", "web"), edge("e2", "web", "db")],
            }),
        );

    it("returns the projected edges where the node is an endpoint, either direction", () => {
        expect(
            projection()
                .edgesTouching("web")
                .map((e) => e.id)
                .sort(),
        ).toEqual(["campus:api->web", "campus:web->db"]);
    });

    it("returns only the edges touching the node, not unrelated ones", () => {
        expect(
            projection()
                .edgesTouching("api")
                .map((e) => e.id),
        ).toEqual(["campus:api->web"]);
    });

    it("returns no edges for a campus node nothing connects to", () => {
        const withIsland = projectToVisible(
            map({
                nodes: [
                    node("d1", { kind: "scope", archetype: "district" }),
                    node("api", { parentId: "d1" }),
                    node("island"),
                ],
                edges: [],
            }),
        );
        expect(withIsland.edgesTouching("island")).toEqual([]);
    });
});
