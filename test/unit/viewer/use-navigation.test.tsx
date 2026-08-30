import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useNavigation } from "@/hooks/use-navigation";
import type { CityNode } from "@/lib/city-map";
import type { NavigationContext } from "@/lib/navigation";

/** A single-district campus with one building (api) that has one room. */
function context(): NavigationContext {
    const nodes: CityNode[] = [
        { id: "api", label: "API", kind: "module", archetype: "gateway" },
        { id: "web", label: "Web", kind: "module", archetype: "building" },
        { id: "api/r1", label: "Router", kind: "module", archetype: "room", parentId: "api" },
        { id: "api/r2", label: "Auth", kind: "module", archetype: "room", parentId: "api" },
    ];
    return {
        visibleIds: new Set(["api", "web"]),
        nodeById: new Map(nodes.map((node) => [node.id, node])),
        edges: [{ id: "e-web-api", from: "web", to: "api", kind: "calls", evidence: "declared" }],
        districts: [{ id: "d-front", nodeIds: ["web", "api"] }],
    };
}

describe("useNavigation", () => {
    it("starts on the plain campus view", () => {
        const { result } = renderHook(() => useNavigation(context()));
        expect(result.current.view.mode).toBe("campus");
        expect(result.current.view.selectedId).toBe("");
    });

    it("applies a gesture through its callback", () => {
        const { result } = renderHook(() => useNavigation(context()));
        act(() => result.current.explore("api"));
        expect(result.current.view.mode).toBe("interior");
        expect(result.current.view.expandedId).toBe("api");
    });

    it("steps back one level when Escape is pressed", () => {
        const { result } = renderHook(() => useNavigation(context()));
        act(() => result.current.explore("api"));
        act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
        expect(result.current.view.mode).toBe("campus");
    });

    it("ignores non-Escape keys", () => {
        const { result } = renderHook(() => useNavigation(context()));
        act(() => result.current.explore("api"));
        act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
        expect(result.current.view.mode).toBe("interior");
    });

    it("selects through the select callback", () => {
        const { result } = renderHook(() => useNavigation(context()));
        act(() => result.current.select("web"));
        expect(result.current.view.selectedId).toBe("web");
    });

    it("enters and toggles district mode through exploreDistrict", () => {
        const { result } = renderHook(() => useNavigation(context()));
        act(() => result.current.exploreDistrict("d-front"));
        expect(result.current.view.mode).toBe("district");
        act(() => result.current.exploreDistrict("d-front"));
        expect(result.current.view.mode).toBe("campus");
    });

    it("steps back through the back callback", () => {
        const { result } = renderHook(() => useNavigation(context()));
        act(() => result.current.exploreDistrict("d-front"));
        act(() => result.current.back());
        expect(result.current.view.mode).toBe("campus");
    });

    it("clears the selection through the deselect callback on the campus view", () => {
        const { result } = renderHook(() => useNavigation(context()));
        act(() => result.current.select("web"));
        act(() => result.current.deselect());
        expect(result.current.view.selectedId).toBe("");
    });
});
