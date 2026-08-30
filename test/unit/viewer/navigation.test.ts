// Characterisation tests for the viewer's navigation state machine. The module
// is pure (its runtime imports are type-only plus React types that are never
// invoked here), so this suite runs in the node project: a plain `.test.ts`
// under test/unit/viewer is picked up by the generator project's
// `test/**/*.test.ts` glob and skipped by the viewer project's `*.test.tsx`
// glob (see flow-layout.test.ts for the same convention).
import { describe, expect, it } from "vitest";
import type { CityEdge, CityNode } from "../../../viewer/lib/city-map";
import {
    back,
    closestVisibleAncestor,
    deriveNavigation,
    deselect,
    explore,
    exploreDistrict,
    INITIAL_NAVIGATION,
    type NavigationContext,
    type NavigationState,
    select,
} from "../../../viewer/lib/navigation";

/**
 * Builds a CityNode with quiet defaults so a fixture spells out only the fields
 * a case exercises.
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

/** Builds a plain "calls" CityEdge between two node ids. */
function edge(id: string, from: string, to: string, overrides: Partial<CityEdge> = {}): CityEdge {
    return { id, from, to, kind: overrides.kind ?? "calls", evidence: overrides.evidence ?? "declared", ...overrides };
}

// A small campus: two districts, three visible campus structures (api, web,
// db), and a campus building (api) with two interior rooms. Edges connect
// web->api and api->db so focus mode and connection preselection have
// something to trace.
const NODES: CityNode[] = [
    node("api", { label: "API", archetype: "gateway" }),
    node("web", { label: "Web" }),
    node("db", { label: "DB", archetype: "database" }),
    node("api/r1", { label: "Router", archetype: "room", parentId: "api" }),
    node("api/r2", { label: "Auth", archetype: "room", parentId: "api" }),
];
const EDGES: CityEdge[] = [edge("e-web-api", "web", "api"), edge("e-api-db", "api", "db")];

/** Builds the navigation context for the fixture campus. */
function context(): NavigationContext {
    return {
        visibleIds: new Set(["api", "web", "db"]),
        nodeById: new Map(NODES.map((n) => [n.id, n])),
        edges: EDGES,
        districts: [
            { id: "d-front", nodeIds: ["web", "api"] },
            { id: "d-back", nodeIds: ["db"] },
        ],
    };
}

/** Builds a navigation state, overriding fields on the empty initial state. */
function state(overrides: Partial<NavigationState> = {}): NavigationState {
    return { ...INITIAL_NAVIGATION, ...overrides };
}

describe("closestVisibleAncestor", () => {
    it("projects a hidden room onto its visible campus building", () => {
        expect(closestVisibleAncestor("api/r1", context())).toBe("api");
    });

    it("returns null when the whole ancestor chain is hidden", () => {
        // A node whose parent is itself hidden and district-less: no visible
        // ancestor exists anywhere up the chain.
        const ctx: NavigationContext = {
            ...context(),
            nodeById: new Map([
                ["hidden", node("hidden", { archetype: "room" })],
                ["leaf", node("leaf", { archetype: "room", parentId: "hidden" })],
            ]),
            visibleIds: new Set<string>(),
        };
        expect(closestVisibleAncestor("leaf", ctx)).toBeNull();
    });
});

describe("deriveNavigation precedence", () => {
    it("lets an open interior beat both focus and district", () => {
        const view = deriveNavigation(state({ expandedId: "api", focusId: "web", districtId: "d-front" }), context());
        expect(view.mode).toBe("interior");
        expect(view.expandedId).toBe("api");
        expect(view.focusId).toBeNull();
        expect(view.districtId).toBeNull();
    });

    it("lets a focused node beat a district", () => {
        const view = deriveNavigation(state({ focusId: "web", districtId: "d-front" }), context());
        expect(view.mode).toBe("focus");
        expect(view.focusId).toBe("web");
        expect(view.districtId).toBeNull();
    });

    it("shows district mode when only a district is set", () => {
        const view = deriveNavigation(state({ districtId: "d-front" }), context());
        expect(view.mode).toBe("district");
        expect(view.districtId).toBe("d-front");
    });

    it("falls back to campus mode with nothing active", () => {
        expect(deriveNavigation(INITIAL_NAVIGATION, context()).mode).toBe("campus");
    });

    it("clears anchors that are no longer reachable in the map", () => {
        const view = deriveNavigation(state({ expandedId: "ghost", focusId: "ghost", districtId: "ghost" }), context());
        expect(view.mode).toBe("campus");
        expect(view.expandedId).toBeNull();
        expect(view.focusId).toBeNull();
        expect(view.districtId).toBeNull();
    });

    it("keeps a selected interior room while its building is open", () => {
        const view = deriveNavigation(state({ expandedId: "api", selectedId: "api/r1" }), context());
        expect(view.selectedId).toBe("api/r1");
    });

    it("drops a selection that has left the current scene", () => {
        const view = deriveNavigation(state({ selectedId: "api/r1" }), context());
        expect(view.selectedId).toBe("");
    });
});

describe("select", () => {
    it("commits the selection and preselects a connection touching it", () => {
        const next = select(INITIAL_NAVIGATION, context(), "web");
        expect(next.selectedId).toBe("web");
        expect(next.selectedConnectionId).toBe("e-web-api");
    });

    it("drops focus when the pick is unrelated to the focused node", () => {
        // db is focused; web connects only to api, not to db, so focus drops.
        const next = select(state({ focusId: "db" }), context(), "web");
        expect(next.focusId).toBeNull();
    });

    it("keeps focus and traces the connecting edge when the pick connects to the focus", () => {
        const next = select(state({ focusId: "web" }), context(), "api");
        expect(next.focusId).toBe("web");
        expect(next.selectedConnectionId).toBe("e-web-api");
    });

    it("selects a room by its own id while resolving the connection at campus level", () => {
        const next = select(state({ expandedId: "api" }), context(), "api/r1");
        expect(next.selectedId).toBe("api/r1");
        // api/r1 projects to api, whose first campus connection is web->api.
        expect(next.selectedConnectionId).toBe("e-web-api");
    });
});

describe("explore", () => {
    it("opens a building's interior and selects it", () => {
        const next = explore(INITIAL_NAVIGATION, context(), "api");
        expect(next.expandedId).toBe("api");
        expect(next.focusId).toBeNull();
        expect(next.selectedId).toBe("api");
    });

    it("toggles an open interior shut when the same building is explored again", () => {
        const next = explore(state({ expandedId: "api" }), context(), "api");
        expect(next.expandedId).toBeNull();
    });

    it("selects a room without closing the building it belongs to", () => {
        const next = explore(state({ expandedId: "api" }), context(), "api/r1");
        expect(next.expandedId).toBe("api");
        expect(next.selectedId).toBe("api/r1");
    });

    it("enters focus mode on a leaf node's campus ancestor", () => {
        const next = explore(INITIAL_NAVIGATION, context(), "web");
        expect(next.focusId).toBe("web");
        expect(next.expandedId).toBeNull();
        expect(next.selectedId).toBe("web");
    });

    it("leaves focus mode when the focused node is explored again", () => {
        const next = explore(state({ focusId: "web" }), context(), "web");
        expect(next.focusId).toBeNull();
        expect(next.selectedId).toBe("web");
    });

    it("always leaves district mode", () => {
        const next = explore(state({ districtId: "d-front" }), context(), "web");
        expect(next.districtId).toBeNull();
    });
});

describe("exploreDistrict", () => {
    it("highlights a district and selects its first node, clearing other modes", () => {
        const next = exploreDistrict(state({ expandedId: "api", focusId: "web" }), context(), "d-front");
        expect(next.districtId).toBe("d-front");
        expect(next.expandedId).toBeNull();
        expect(next.focusId).toBeNull();
        expect(next.selectedId).toBe("web");
    });

    it("toggles the active district off when chosen again", () => {
        const next = exploreDistrict(state({ districtId: "d-front" }), context(), "d-front");
        expect(next.districtId).toBeNull();
    });

    it("leaves state unchanged for an unknown district", () => {
        const before = state({ selectedId: "web" });
        expect(exploreDistrict(before, context(), "ghost")).toEqual(before);
    });
});

describe("back (Escape and the back button)", () => {
    it("steps out of an interior back to the campus, reselecting the building", () => {
        const next = back(state({ expandedId: "api", selectedId: "api/r1" }), context());
        expect(next.expandedId).toBeNull();
        expect(next.selectedId).toBe("api");
    });

    it("steps out of focus mode, reselecting the focused node", () => {
        const next = back(state({ focusId: "web", selectedId: "api" }), context());
        expect(next.focusId).toBeNull();
        expect(next.selectedId).toBe("web");
    });

    it("steps out of district mode", () => {
        const next = back(state({ districtId: "d-front" }), context());
        expect(next.districtId).toBeNull();
    });

    it("prefers interior over focus and district when several are set", () => {
        const next = back(state({ expandedId: "api", focusId: "web", districtId: "d-front" }), context());
        expect(next.expandedId).toBeNull();
        expect(next.focusId).toBe("web");
        expect(next.districtId).toBe("d-front");
    });

    it("does nothing on the plain campus view", () => {
        expect(back(INITIAL_NAVIGATION, context())).toEqual(INITIAL_NAVIGATION);
    });
});

describe("deselect (background click)", () => {
    it("clears the selection on the plain campus view", () => {
        const next = deselect(state({ selectedId: "web", selectedConnectionId: "e-web-api" }), context());
        expect(next.selectedId).toBe("");
        expect(next.selectedConnectionId).toBeNull();
    });

    it("keeps the interior building selected instead of deselecting inside a drill-down", () => {
        const next = deselect(state({ expandedId: "api", selectedId: "api/r1" }), context());
        expect(next.selectedId).toBe("api");
        expect(next.expandedId).toBe("api");
    });

    it("keeps the focused node selected while focus mode stays open", () => {
        const next = deselect(state({ focusId: "web", selectedId: "api" }), context());
        expect(next.selectedId).toBe("web");
        expect(next.focusId).toBe("web");
    });
});
