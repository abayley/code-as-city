// Characterisation tests for the deterministic ground-plane layout. The module
// is pure (its sole import is type-only), so this suite runs in the node
// project: a plain `.test.ts` is picked up by the generator project's
// `test/**/*.test.ts` glob and skipped by the viewer project's `*.test.tsx`
// glob, so it runs once, in node, with no jsdom cost and no `@` alias needed.
import { describe, expect, it } from "vitest";
import type { CityEdge, CityNode } from "../../../viewer/lib/city-map";
import { computeFlowLayout, createEdgeRouter, type FlowLayout } from "../../../viewer/lib/flow-layout";

/**
 * Builds a CityNode with sensible defaults, overridable per field, so fixtures
 * stay small and only spell out what a case actually exercises.
 */
function node(id: string, overrides: Partial<CityNode> = {}): CityNode {
    return {
        id,
        label: overrides.label ?? id,
        kind: overrides.kind ?? "module",
        archetype: overrides.archetype ?? "building",
        ...overrides,
    };
}

/**
 * Builds a CityEdge with the given endpoints; defaults to a non-deploy
 * "calls" edge so it participates in flow layering.
 */
function edge(id: string, from: string, to: string, overrides: Partial<CityEdge> = {}): CityEdge {
    return {
        id,
        from,
        to,
        kind: overrides.kind ?? "calls",
        evidence: overrides.evidence ?? "declared",
        ...overrides,
    };
}

/** True when [x, z] sits within the layout bounds (inclusive). */
function withinBounds(position: [number, number], bounds: FlowLayout["bounds"]) {
    const [x, z] = position;
    return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

describe("computeFlowLayout", () => {
    it("returns the sentinel empty layout for no nodes", () => {
        const layout = computeFlowLayout([], [], []);
        expect(layout.positions.size).toBe(0);
        expect(layout.layers.size).toBe(0);
        expect(layout.districts).toEqual([]);
        expect(layout.bounds).toEqual({ minX: -1, maxX: 1, minZ: -1, maxZ: 1 });
    });

    it("is deterministic: identical inputs produce a deep-equal layout", () => {
        const nodes = [
            node("a", { kind: "deployable", archetype: "gateway", label: "API gateway" }),
            node("b"),
            node("c", { kind: "infra", archetype: "database", label: "Postgres" }),
        ];
        const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")];

        const first = computeFlowLayout(nodes, edges, nodes);
        const second = computeFlowLayout(nodes, edges, nodes);

        expect(second).toEqual(first);
    });

    it("places every node inside the reported bounds and layers edges front to back", () => {
        const nodes = [node("a", { label: "cli entry" }), node("b"), node("c", { archetype: "database" })];
        const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")];

        const layout = computeFlowLayout(nodes, edges, nodes);

        for (const id of ["a", "b", "c"]) {
            const position = layout.positions.get(id);
            expect(position, `position for ${id}`).toBeDefined();
            if (position) expect(withinBounds(position, layout.bounds), `${id} within bounds`).toBe(true);
        }
        const layerOf = (id: string) => layout.layers.get(id) ?? -1;
        // A directed chain a -> b -> c must not regress in layer along its flow.
        expect(layerOf("a")).toBeLessThanOrEqual(layerOf("b"));
        expect(layerOf("b")).toBeLessThanOrEqual(layerOf("c"));
    });

    it("honours an explicit display.flowLayer over hinted staging", () => {
        const nodes = [
            node("front", { display: { flowLayer: 0 } }),
            node("back", { archetype: "gateway", display: { flowLayer: 3 } }),
        ];

        const layout = computeFlowLayout(nodes, [], nodes);

        // Compacted to 0 and 1, but order is preserved: front before back.
        expect(layout.layers.get("front") ?? -1).toBeLessThan(layout.layers.get("back") ?? -1);
    });

    it("groups nodes sharing a scope into one district whose bounds contain them", () => {
        const scope = node("s", { kind: "scope", archetype: "district", label: "Payments" });
        const nodes = [
            node("a", { parentId: "s" }),
            node("b", { parentId: "s" }),
            node("s", { kind: "scope", archetype: "district", label: "Payments" }),
        ];
        const edges = [edge("e1", "a", "b")];

        const layout = computeFlowLayout(nodes, edges, [scope, ...nodes]);

        const district = layout.districts.find((entry) => entry.id === "s");
        expect(district, "district s").toBeDefined();
        if (!district) return;
        expect(new Set(district.nodeIds)).toEqual(new Set(["a", "b"]));
        expect(district.label).toBe("Payments");
        for (const id of ["a", "b"]) {
            const position = layout.positions.get(id);
            expect(position).toBeDefined();
            if (position) {
                expect(position[0]).toBeGreaterThanOrEqual(district.bounds.minX);
                expect(position[0]).toBeLessThanOrEqual(district.bounds.maxX);
                expect(position[1]).toBeGreaterThanOrEqual(district.bounds.minZ);
                expect(position[1]).toBeLessThanOrEqual(district.bounds.maxZ);
            }
        }
    });

    it("orders districts by band (scope flowLayer) front to back", () => {
        const scopeFront = node("front", {
            kind: "scope",
            archetype: "district",
            label: "Front",
            display: { flowLayer: 0 },
        });
        const scopeBack = node("back", {
            kind: "scope",
            archetype: "district",
            label: "Back",
            display: { flowLayer: 2 },
        });
        const nodes = [scopeFront, scopeBack, node("fa", { parentId: "front" }), node("ba", { parentId: "back" })];

        const layout = computeFlowLayout(nodes, [], nodes);

        const bands = layout.districts.filter((d) => !d.id.startsWith("__")).map((d) => ({ id: d.id, band: d.band }));
        expect(bands).toEqual([
            { id: "front", band: 0 },
            { id: "back", band: 2 },
        ]);
    });

    it("routes a scope-less connected node into a satellite '__near' district", () => {
        const scope = node("s", { kind: "scope", archetype: "district", label: "Core" });
        const nodes = [scope, node("in", { parentId: "s" }), node("loose")];
        const edges = [edge("e1", "loose", "in")];

        const layout = computeFlowLayout(nodes, edges, nodes);

        const near = layout.districts.find((entry) => entry.id === "__near:s");
        expect(near, "__near:s district").toBeDefined();
        expect(near?.nodeIds).toContain("loose");
        expect(near?.label).toBe("Near Core");
    });

    it("routes a scope-less unconnected node into the '__system' district", () => {
        const nodes = [node("island")];

        const layout = computeFlowLayout(nodes, [], nodes);

        const system = layout.districts.find((entry) => entry.id === "__system");
        expect(system, "__system district").toBeDefined();
        expect(system?.nodeIds).toEqual(["island"]);
        expect(system?.label).toBe("System");
    });

    it("falls back to all in-scope edges when only deploy edges connect the nodes", () => {
        const nodes = [node("a"), node("b")];
        const edges = [edge("e1", "a", "b", { kind: "deploys" })];

        // Should not throw and should still place both nodes; the deploy edge is
        // used for layering only because no non-deploy edge exists.
        const layout = computeFlowLayout(nodes, edges, nodes);

        expect(layout.positions.size).toBe(2);
    });
});

describe("createEdgeRouter", () => {
    const nodes = [node("a", { label: "entry" }), node("b"), node("c", { archetype: "database" })];
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")];

    it("routes an edge as ground-plane waypoints starting and ending at the endpoints", () => {
        const layout = computeFlowLayout(nodes, edges, nodes);
        const router = createEdgeRouter(layout, nodes);

        const path = router.route(edges[0] as CityEdge);
        expect(path, "route for e1").not.toBeNull();
        if (!path) return;
        expect(path.length).toBeGreaterThanOrEqual(2);
        expect(path[0]).toEqual(layout.positions.get("a"));
        expect(path[path.length - 1]).toEqual(layout.positions.get("b"));
    });

    it("caches per edge id: repeated route() calls return the identical array", () => {
        const layout = computeFlowLayout(nodes, edges, nodes);
        const router = createEdgeRouter(layout, nodes);

        const first = router.route(edges[0] as CityEdge);
        const second = router.route(edges[0] as CityEdge);
        expect(second).toBe(first);
    });

    it("returns null for an edge whose endpoints are absent from the layout", () => {
        const layout = computeFlowLayout(nodes, edges, nodes);
        const router = createEdgeRouter(layout, nodes);

        const path = router.route(edge("ghost", "missing-from", "missing-to"));
        expect(path).toBeNull();
    });

    it("bails to null routes when the grid would exceed the cell cap", () => {
        // The 600_000-cell guard is reachable directly because the router takes a
        // FlowLayout: an enormous bounding box makes cols*rows blow past the cap.
        const layout: FlowLayout = {
            positions: new Map([
                ["a", [0, 0]],
                ["b", [1, 1]],
            ]),
            layers: new Map([
                ["a", 0],
                ["b", 1],
            ]),
            districts: [],
            bounds: { minX: -5000, maxX: 5000, minZ: -5000, maxZ: 5000 },
        };
        const router = createEdgeRouter(layout, nodes);

        expect(router.route(edge("e1", "a", "b"))).toBeNull();
    });
});

// The A* expansion cap (expansions < 150_000) and the invariant-guard throws
// ("Compacted layer missing", "Node missing from layer map", "Node missing
// from positions map", "Heap pop on empty heap") are deliberately not
// exercised here. The throws are internal invariants: `layers` and `positions`
// are populated for every input node before any lookup, so no valid
// CityNode[]/CityEdge[] can reach them through the two public functions. The
// expansion cap needs a fully open grid large enough for A* to expand 150k
// states without reaching the goal yet small enough to clear the 600k-cell
// bail -- constructible only with a heavy fixture whose runtime cost is not
// worth the single branch.
