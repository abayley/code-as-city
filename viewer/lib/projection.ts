// The campus projection: collapsing the full map's node/edge graph onto the
// currently visible (campus) level. "Which nodes render at city level", the
// evidence-priority edge dedup, and the ancestor walk that projects a hidden
// room's edges onto its campus building are one idea; they live here as pure
// functions over a CityMap so they can be tested with plain fixtures, and so the
// navigation machine and the RepoCity component read one projection instead of
// recomputing the pieces in the component body.
import type { CityEdge, CityMap, CityNode, EvidenceKind } from "./city-map";

/** The node table and the set of visible ids the ancestor walk reads. */
export type AncestorLookup = {
    /** Lookup for every node in the map. */
    nodeById: ReadonlyMap<string, CityNode>;
    /** The ids currently rendered at campus level. */
    visibleIds: ReadonlySet<string>;
};

/**
 * Walks up the parent chain from a node to the nearest ancestor that is
 * currently rendered on the campus view, so edges between hidden rooms can be
 * projected onto their campus-level buildings.
 *
 * @param nodeId - The node to start from.
 * @param lookup - The node table and the set of currently visible ids.
 * @returns The nearest visible ancestor's id (possibly the node itself), or
 *   null when the whole chain is hidden.
 */
export function closestVisibleAncestor(nodeId: string, lookup: AncestorLookup): string | null {
    let current = lookup.nodeById.get(nodeId);
    while (current) {
        if (lookup.visibleIds.has(current.id)) return current.id;
        current = current.parentId ? lookup.nodeById.get(current.parentId) : undefined;
    }
    return null;
}

/** The campus-level view of a map: the visible nodes, their edges, and the helpers to walk between. */
export type CampusProjection = {
    /** The nodes rendered at campus level. */
    nodes: CityNode[];
    /** Their ids. */
    ids: Set<string>;
    /** Lookup for every node in the map (rooms included), for ancestor walks. */
    nodeById: Map<string, CityNode>;
    /** The edges projected onto campus level, deduped per pair to the strongest evidence. */
    edges: CityEdge[];
    /** Projects a node id onto its campus building (see {@link closestVisibleAncestor}). */
    ancestorOf: (nodeId: string) => string | null;
    /** The projected campus edges the given node is an endpoint of, in either direction. */
    edgesTouching: (nodeId: string) => CityEdge[];
};

/**
 * Tests whether a node belongs on the campus (city-level) view: any non-scope
 * node whose parent is a district (a scope) or missing. Campus structures may be
 * district-less.
 */
function isCampusNode(node: CityNode, nodeById: ReadonlyMap<string, CityNode>): boolean {
    return node.kind !== "scope" && (!node.parentId || nodeById.get(node.parentId)?.kind === "scope");
}

/**
 * Collapses a map onto its campus level: selects the campus nodes, projects
 * every edge onto the visible pair of campus ancestors (dropping self-loops and
 * edges whose endpoints have no visible ancestor), and dedupes each campus pair
 * to its highest-evidence edge (observed beats declared beats inferred). The
 * projected edge id is `campus:<from>-><to>`.
 *
 * @param map - The full city map.
 * @returns The campus projection: nodes, ids, the node index, the projected
 *   edges, and the {@link closestVisibleAncestor} helper bound to it.
 */
export function projectToVisible(map: CityMap): CampusProjection {
    const nodeById = new Map(map.nodes.map((node) => [node.id, node]));
    const nodes = map.nodes.filter((node) => isCampusNode(node, nodeById));
    const ids = new Set(nodes.map((node) => node.id));
    const lookup: AncestorLookup = { nodeById, visibleIds: ids };
    const evidencePriority: Record<EvidenceKind, number> = { observed: 3, declared: 2, inferred: 1 };
    const projected = new Map<string, CityEdge>();
    for (const edge of map.edges) {
        const from = closestVisibleAncestor(edge.from, lookup);
        const to = closestVisibleAncestor(edge.to, lookup);
        if (!from || !to || from === to) continue;
        const key = `${from}->${to}`;
        const existing = projected.get(key);
        if (!existing || evidencePriority[edge.evidence] > evidencePriority[existing.evidence]) {
            projected.set(key, { ...edge, id: `campus:${key}`, from, to });
        }
    }
    const edges = [...projected.values()];
    return {
        nodes,
        ids,
        nodeById,
        edges,
        ancestorOf: (nodeId: string) => closestVisibleAncestor(nodeId, lookup),
        edgesTouching: (nodeId: string) => edges.filter((edge) => edge.from === nodeId || edge.to === nodeId),
    };
}
