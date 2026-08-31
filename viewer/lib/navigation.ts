// The viewer's navigation state machine, extracted from the RepoCity component
// so the campus/district/focus/interior gesture grammar can be exercised
// without mounting a WebGL canvas.
//
// The city view is one lattice with a fixed precedence: an open interior beats
// a focused node, which beats a highlighted district. That rule, the drill-down
// anchor rules, and the "Escape steps back one level" policy used to be
// re-derived in several closures inside the component. They live here once, as
// pure functions over an explicit {@link NavigationContext}, so both the
// component and its tests read the same decisions.
import type { CityEdge, CityNode } from "./city-map";
import { closestVisibleAncestor } from "./projection";

/**
 * The raw navigation state the machine transitions between. The clamped,
 * render-ready view is computed by {@link deriveNavigation}; these fields may
 * hold ids that are no longer reachable (a stale anchor), which the derivation
 * resolves.
 */
export type NavigationState = {
    /** The committed selection (a room or campus structure), or "" for none. */
    selectedId: string;
    /** The preselected connection (a map edge id), or null. */
    selectedConnectionId: string | null;
    /** The campus building whose interior is open, or null. */
    expandedId: string | null;
    /** The campus node whose direct connections are traced, or null. */
    focusId: string | null;
    /** The highlighted district, or null. */
    districtId: string | null;
};

/** The empty starting state: nothing selected, no drill-down active. */
export const INITIAL_NAVIGATION: NavigationState = {
    selectedId: "",
    selectedConnectionId: null,
    expandedId: null,
    focusId: null,
    districtId: null,
};

/**
 * The map-derived lookups the machine reads. Everything here is stable for a
 * given loaded map, so callers memoise it once and the transitions stay pure.
 */
export type NavigationContext = {
    /** Every campus-level (city-view) node id. */
    visibleIds: ReadonlySet<string>;
    /** Lookup for every node in the map, for ancestor walks and parent checks. */
    nodeById: ReadonlyMap<string, CityNode>;
    /** Every map edge, projected to campus level on demand. */
    edges: readonly CityEdge[];
    /** The campus districts, in layout order, each with its member node ids. */
    districts: readonly { id: string; nodeIds: readonly string[] }[];
};

/** Which drill-down level the city view is currently showing. */
export type NavigationMode = "campus" | "district" | "focus" | "interior";

/**
 * The clamped, render-ready navigation view: exactly one drill-down mode is
 * active, and every id is guaranteed reachable in the current map. Every
 * consumer (the scene, the overlays, the inspector) reads this instead of
 * re-deriving the precedence.
 */
export type NavigationView = {
    /** The single active drill-down level. */
    mode: NavigationMode;
    /** The committed selection, cleared to "" when it left the current scene. */
    selectedId: string;
    /** The preselected connection (a map edge id), or null. */
    selectedConnectionId: string | null;
    /** The open interior's building id, or null when not in interior mode. */
    expandedId: string | null;
    /** The focused node's id, or null when not in focus mode. */
    focusId: string | null;
    /** The highlighted district's id, or null when not in district mode. */
    districtId: string | null;
};

/** The campus building whose interior is open, once stale anchors are cleared. */
function activeExpanded(state: NavigationState, context: NavigationContext): string | null {
    return state.expandedId && context.visibleIds.has(state.expandedId) ? state.expandedId : null;
}

/** The focused node, active only when no interior beats it. */
function activeFocus(state: NavigationState, context: NavigationContext): string | null {
    return state.focusId && context.visibleIds.has(state.focusId) && !activeExpanded(state, context)
        ? state.focusId
        : null;
}

/** The highlighted district, active only when no interior or focus beats it. */
function activeDistrict(state: NavigationState, context: NavigationContext): string | null {
    return state.districtId &&
        context.districts.some((district) => district.id === state.districtId) &&
        !activeExpanded(state, context) &&
        !activeFocus(state, context)
        ? state.districtId
        : null;
}

/** The nodes that render as an open interior beneath a campus building. */
function childrenOf(nodeId: string, context: NavigationContext): CityNode[] {
    return [...context.nodeById.values()].filter((node) => node.parentId === nodeId);
}

/**
 * Finds the first map edge that, projected to campus level, touches the given
 * campus node — used to preselect a connection on selection.
 */
function firstCampusConnection(nodeId: string, context: NavigationContext): CityEdge | undefined {
    return context.edges.find((edge) => {
        const from = closestVisibleAncestor(edge.from, context);
        const to = closestVisibleAncestor(edge.to, context);
        return from && to && from !== to && (from === nodeId || to === nodeId);
    });
}

/** Finds a map edge whose campus-level projection runs between two nodes. */
function connectionBetween(leftId: string, rightId: string, context: NavigationContext): CityEdge | undefined {
    return context.edges.find((edge) => {
        const from = closestVisibleAncestor(edge.from, context);
        const to = closestVisibleAncestor(edge.to, context);
        return (from === leftId && to === rightId) || (from === rightId && to === leftId);
    });
}

/**
 * Clamps the raw state into the render-ready view: resolves the drill-down
 * precedence (interior beats focus beats district), and drops a selection that
 * has left the current scene.
 *
 * @param state - The raw navigation state.
 * @param context - The current map lookups.
 * @returns The single active mode and reachable ids the consumers render.
 */
export function deriveNavigation(state: NavigationState, context: NavigationContext): NavigationView {
    const expandedId = activeExpanded(state, context);
    const focusId = activeFocus(state, context);
    const districtId = activeDistrict(state, context);
    const sceneIds = new Set([
        ...context.visibleIds,
        ...(expandedId ? childrenOf(expandedId, context) : []).map((n) => n.id),
    ]);
    const selectedId = state.selectedId && sceneIds.has(state.selectedId) ? state.selectedId : "";
    const mode: NavigationMode = expandedId ? "interior" : focusId ? "focus" : districtId ? "district" : "campus";
    return { mode, selectedId, selectedConnectionId: state.selectedConnectionId, expandedId, focusId, districtId };
}

/**
 * Selects a node (single click): commits the selection, preselects a
 * connection touching it, and drops focus mode when the pick is unrelated to
 * the focused node.
 *
 * @param state - The current navigation state.
 * @param context - The current map lookups.
 * @param nodeId - The clicked node's id (room or campus structure).
 * @returns The next state.
 */
export function select(state: NavigationState, context: NavigationContext, nodeId: string): NavigationState {
    const focusId = activeFocus(state, context);
    const campusNodeId = closestVisibleAncestor(nodeId, context);
    const focusedConnection =
        focusId && campusNodeId && campusNodeId !== focusId ? connectionBetween(focusId, campusNodeId, context) : null;
    const dropsFocus = Boolean(focusId && campusNodeId && campusNodeId !== focusId && !focusedConnection);
    return {
        ...state,
        focusId: dropsFocus ? null : state.focusId,
        selectedId: nodeId,
        selectedConnectionId:
            focusedConnection?.id ??
            (campusNodeId ? firstCampusConnection(campusNodeId, context)?.id : null) ??
            context.edges.find((edge) => edge.from === nodeId || edge.to === nodeId)?.id ??
            null,
    };
}

/**
 * Opens a node (double-click or rail click): expands a building's rooms when it
 * has children, selects a room while its building stays open, otherwise toggles
 * focus mode on the node's campus ancestor to trace its direct connections.
 * Always leaves district mode.
 *
 * @param state - The current navigation state.
 * @param context - The current map lookups.
 * @param nodeId - The activated node's id.
 * @returns The next state.
 */
export function explore(state: NavigationState, context: NavigationContext, nodeId: string): NavigationState {
    const children = childrenOf(nodeId, context);
    if (children.length) {
        const nextExpanded = state.expandedId === nodeId ? null : nodeId;
        return { ...select(state, context, nodeId), districtId: null, focusId: null, expandedId: nextExpanded };
    }
    const expandedId = activeExpanded(state, context);
    if (expandedId && context.nodeById.get(nodeId)?.parentId === expandedId) {
        return { ...select(state, context, nodeId), districtId: null };
    }
    const campusNodeId = closestVisibleAncestor(nodeId, context);
    if (!campusNodeId) return { ...state, districtId: null };
    if (campusNodeId === activeFocus(state, context)) {
        return { ...select(state, context, campusNodeId), districtId: null, expandedId: null, focusId: null };
    }
    return {
        ...state,
        districtId: null,
        expandedId: null,
        focusId: campusNodeId,
        selectedId: nodeId,
        selectedConnectionId: firstCampusConnection(campusNodeId, context)?.id ?? null,
    };
}

/**
 * Toggles district mode: highlights a district and selects its first node, or
 * leaves the mode when the active district is chosen again.
 *
 * @param state - The current navigation state.
 * @param context - The current map lookups.
 * @param nextDistrictId - The district to explore.
 * @returns The next state.
 */
export function exploreDistrict(
    state: NavigationState,
    context: NavigationContext,
    nextDistrictId: string,
): NavigationState {
    if (activeDistrict(state, context) === nextDistrictId) return { ...state, districtId: null };
    const district = context.districts.find((candidate) => candidate.id === nextDistrictId);
    const firstNodeId = district?.nodeIds[0];
    if (!district || !firstNodeId) return state;
    return {
        ...state,
        expandedId: null,
        focusId: null,
        districtId: nextDistrictId,
        selectedId: firstNodeId,
        selectedConnectionId: firstCampusConnection(firstNodeId, context)?.id ?? null,
    };
}

/**
 * Steps back one drill-down level: interior, then focus, then district, then
 * nothing. This is the single Escape policy and the single back-button action;
 * leaving a level reselects the anchor that was open, the same way the close
 * buttons always have.
 *
 * @param state - The current navigation state.
 * @param context - The current map lookups.
 * @returns The next state.
 */
export function back(state: NavigationState, context: NavigationContext): NavigationState {
    const expandedId = activeExpanded(state, context);
    if (expandedId) return { ...select(state, context, expandedId), expandedId: null };
    const focusId = activeFocus(state, context);
    if (focusId) return { ...select(state, context, focusId), focusId: null };
    if (activeDistrict(state, context)) return { ...state, districtId: null };
    return state;
}

/**
 * Handles a background click: in a drill-down (interior or focus) the anchor
 * stays selected so the scene and inspector agree; on the plain campus or
 * district view the selection clears.
 *
 * @param state - The current navigation state.
 * @param context - The current map lookups.
 * @returns The next state.
 */
export function deselect(state: NavigationState, context: NavigationContext): NavigationState {
    const anchor = activeExpanded(state, context) ?? activeFocus(state, context);
    return {
        ...state,
        selectedId: anchor ?? "",
        selectedConnectionId: anchor ? (firstCampusConnection(anchor, context)?.id ?? null) : null,
    };
}
