// Deterministic ground-plane layout for the city view: assigns nodes to
// front-to-back flow layers, packs them into districts, and
// routes edges around the resulting buildings.
import type { CityEdge, CityNode } from "./city-map";
import { DEFAULT_FOOTPRINT, MARKER_FOOTPRINT_SCALE, plaqueMetrics, plaqueVariantFor } from "./sizing";

export type FlowLayout = {
    positions: Map<string, [number, number]>;
    layers: Map<string, number>;
    districts: Array<{
        id: string;
        label: string;
        color?: string | undefined;
        band?: number | undefined;
        bandLabel?: string | undefined;
        description?: string | undefined;
        nodeIds: string[];
        bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    }>;
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

const STAGE_HINTS: Array<[RegExp, number]> = [
    [
        /\b(ui|ux|frontend|front-end|web app|client|public api|sdk|command|cli|ingress|gateway|http|graphql|rest|entry|input)\b/i,
        0,
    ],
    [/\b(router|route|controller|orchestrat|service|server|handler|dispatcher|api server)\b/i, 1],
    [/\b(core|domain|engine|compiler|reconciler|processor|transform|model|planner|scheduler|runtime)\b/i, 2],
    [/\b(worker|job|consumer|queue|stream|event|background|replication|controller manager)\b/i, 3],
    [/\b(database|postgres|mysql|sqlite|redis|cache|storage|bucket|filesystem|persistence|etcd|warehouse|index)\b/i, 4],
];

/**
 * Guesses which flow stage (0 = ingress, 4 = persistence) a node belongs to.
 * An explicit display.flowLayer wins; otherwise kind/archetype rules apply,
 * then keyword hints over the label, description, and tags.
 *
 * @param node - The node to place.
 * @returns The zero-based stage index, front of the map first.
 */
function hintedStage(node: CityNode) {
    const explicitLayer = node.display?.flowLayer;
    if (explicitLayer !== undefined && Number.isInteger(explicitLayer)) return Math.max(0, explicitLayer);
    if (node.kind === "external") return 4;
    if (node.archetype === "database" || node.archetype === "storage") return 4;
    if (node.archetype === "queue" || node.archetype === "worker") return 3;

    const searchable = [node.label, node.description, ...(node.tags ?? [])].filter(Boolean).join(" ");
    for (const [pattern, stage] of STAGE_HINTS) if (pattern.test(searchable)) return stage;
    if (node.archetype === "gateway") return 0;
    if (node.kind === "infra") return 3;
    if (node.kind === "module") return 2;
    return 1;
}

/**
 * Selects the edges that should drive flow layering: edges between the given
 * nodes, preferring non-deploy edges and falling back to all in-scope edges
 * when a map has nothing but deploy relationships.
 *
 * @param nodes - The nodes being laid out; edges to anything else are ignored.
 * @param edges - The full edge list to filter.
 * @returns The edges to use for layering and affinity decisions.
 */
function flowEdges(nodes: CityNode[], edges: CityEdge[]) {
    const ids = new Set(nodes.map((node) => node.id));
    const primary = edges.filter((edge) => edge.kind !== "deploys" && ids.has(edge.from) && ids.has(edge.to));
    return primary.length ? primary : edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

/**
 * Computes the whole ground-plane layout: each node's flow layer (front to
 * back), its 2D position, the districts with their plot bounds,
 * and the overall map bounds. Deterministic for a given map, so the camera
 * and edge router can rely on stable coordinates.
 *
 * @param nodes - The nodes to place (the current view's visible structures).
 * @param edges - Edges between those nodes, used for layering and affinity.
 * @param allNodes - Every node in the map, used to resolve district scopes
 *   and to detect interiors when sizing nameplate clearances.
 * @returns The positions, layer assignments, district descriptors, and
 *   bounding box for the laid-out map.
 */
export function computeFlowLayout(nodes: CityNode[], edges: CityEdge[], allNodes: CityNode[]): FlowLayout {
    if (!nodes.length) {
        return {
            positions: new Map(),
            layers: new Map(),
            districts: [],
            bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
        };
    }

    const relevantEdges = flowEdges(nodes, edges);
    const incoming = new Map(nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
    relevantEdges.forEach((edge) => {
        incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
        outgoing.get(edge.from)?.push(edge.to);
    });

    let entries = nodes.filter(
        (node) =>
            node.display?.flowLayer === 0 ||
            (hintedStage(node) === 0 && node.kind !== "external") ||
            ((incoming.get(node.id) ?? 0) === 0 &&
                (outgoing.get(node.id)?.length ?? 0) > 0 &&
                node.kind !== "infra" &&
                node.kind !== "external"),
    );
    if (!entries.length) {
        const firstStage = Math.min(...nodes.map(hintedStage));
        entries = nodes.filter((node) => hintedStage(node) === firstStage);
    }

    const distance = new Map<string, number>();
    const queue = entries.map((node) => node.id);
    queue.forEach((id) => {
        distance.set(id, 0);
    });
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const from = queue[cursor];
        if (from === undefined) continue;
        const nextDistance = (distance.get(from) ?? 0) + 1;
        for (const to of outgoing.get(from) ?? []) {
            const existing = distance.get(to);
            if (existing === undefined || nextDistance < existing) {
                distance.set(to, nextDistance);
                queue.push(to);
            }
        }
    }

    const rawLayers = new Map<string, number>();
    nodes.forEach((node) => {
        const explicit = node.display?.flowLayer;
        const graphStage = distance.get(node.id);
        const stage = explicit ?? Math.max(hintedStage(node), graphStage ?? 0);
        rawLayers.set(node.id, Math.min(stage, 6));
    });

    const usedLayers = [...new Set(rawLayers.values())].sort((a, b) => a - b);
    const compactLayer = new Map(usedLayers.map((layer, index) => [layer, index]));
    const layers = new Map(
        [...rawLayers].map(([id, layer]): [string, number] => {
            const compact = compactLayer.get(layer);
            if (compact === undefined) throw new Error("Compacted layer missing for raw layer.");
            return [id, compact];
        }),
    );
    /**
     * Looks up a node's compacted global flow layer.
     *
     * @param node - A node already present in the layer map.
     * @returns Its zero-based compacted layer index.
     */
    const globalLayerOf = (node: CityNode): number => {
        const layer = layers.get(node.id);
        if (layer === undefined) throw new Error("Node missing from layer map.");
        return layer;
    };

    const scopes = allNodes.filter((node) => node.kind === "scope");
    const scopeById = new Map(scopes.map((scope) => [scope.id, scope]));
    const scopeOrder = new Map(scopes.map((scope, index) => [scope.id, index]));
    // Local change: a district-less node with edges is placed in a satellite
    // strip adjacent to the district it is most connected to, instead of a
    // single far-away "System" strip. Nodes with no affinity keep "__system".
    const scopeOfNode = new Map<string, string>();
    nodes.forEach((node) => {
        if (node.parentId && scopeById.has(node.parentId)) scopeOfNode.set(node.id, node.parentId);
    });
    const affinity = new Map<string, string>();
    nodes.forEach((node) => {
        if (node.parentId && scopeById.has(node.parentId)) return;
        const counts = new Map<string, number>();
        relevantEdges.forEach((edge) => {
            const other = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : null;
            if (!other) return;
            const scope = scopeOfNode.get(other);
            if (scope) counts.set(scope, (counts.get(scope) ?? 0) + 1);
        });
        const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (best) affinity.set(node.id, best[0]);
    });
    /**
     * Resolves the district a node lays out in. Most nodes land in their
     * parent scope; a scope-less node with edges lands in a satellite strip
     * beside the scope it is most connected to, and anything left lands in
     * the synthetic "__system" district.
     *
     * @param node - The node to group.
     * @returns The district id: a scope id, "__near:<scope>", or "__system".
     */
    const districtFor = (node: CityNode) =>
        node.parentId && scopeById.has(node.parentId)
            ? node.parentId
            : affinity.has(node.id)
              ? `__near:${affinity.get(node.id)}`
              : "__system";
    /**
     * Orders districts: scope-backed districts in scope order, each satellite
     * strip directly after the scope it hangs off, and the system district
     * last.
     *
     * @param id - A district id from districtFor.
     * @returns A sortable rank; lower ranks lay out first.
     */
    const districtRank = (id: string) => {
        const order = scopeOrder.get(id);
        if (order !== undefined) return order * 2;
        if (id.startsWith("__near:")) return (scopeOrder.get(id.slice(7)) ?? Number.MAX_SAFE_INTEGER / 4) * 2 + 1;
        return Number.MAX_SAFE_INTEGER;
    };
    const groupedNodes = new Map<string, CityNode[]>();
    nodes.forEach((node) => {
        const districtId = districtFor(node);
        groupedNodes.set(districtId, [...(groupedNodes.get(districtId) ?? []), node]);
    });
    const districtEntries = [...groupedNodes].sort(
        ([left], [right]) => districtRank(left) - districtRank(right) || left.localeCompare(right),
    );
    const nodeStepX = 2.0;
    const nodeStepZ = 1.7;
    // Local change: districts grow roughly square instead of two fixed columns.
    /**
     * Chooses how many columns a group of structures packs into.
     *
     * @param count - Number of structures in the group.
     * @returns The column count that keeps the group roughly square.
     */
    const columnsFor = (count: number) => Math.max(1, Math.ceil(Math.sqrt(count)));
    // Local change: tighter packing for many-district maps. A single-structure
    // district only needs its own footprint, and the gap between
    // districts is decorative, not structural.
    const districtGap = 0.9;

    // Local change: district-level flow layering. Districts themselves are
    // layered by their cross-district edges (producers in front, consumers
    // behind) and laid out in rows instead of one long ribbon. Groups with no
    // cross-district edges at all go to the back row.
    const districtOf = new Map<string, string>();
    nodes.forEach((node) => {
        districtOf.set(node.id, districtFor(node));
    });
    const quotientEdges = new Set<string>();
    relevantEdges.forEach((edge) => {
        const from = districtOf.get(edge.from);
        const to = districtOf.get(edge.to);
        if (from && to && from !== to) quotientEdges.add(`${from}=>${to}`);
    });
    const groupIds = districtEntries.map(([id]) => id);
    const hasQuotientEdge = new Set([...quotientEdges].flatMap((key) => key.split("=>")));
    const incomingCount = new Map(groupIds.map((id) => [id, 0]));
    quotientEdges.forEach((key) => {
        const to = key.split("=>")[1];
        if (to === undefined) return;
        incomingCount.set(to, (incomingCount.get(to) ?? 0) + 1);
    });
    const districtLayer = new Map<string, number>();
    groupIds.forEach((id) => {
        if (hasQuotientEdge.has(id) && (incomingCount.get(id) ?? 0) === 0) districtLayer.set(id, 0);
    });
    for (let pass = 0; pass <= groupIds.length; pass += 1) {
        let changed = false;
        quotientEdges.forEach((key) => {
            const [from, to] = key.split("=>");
            if (from === undefined || to === undefined) return;
            const fromLayer = districtLayer.get(from);
            if (fromLayer === undefined) return;
            const proposed = fromLayer + 1;
            if ((districtLayer.get(to) ?? -1) < proposed && proposed <= groupIds.length) {
                districtLayer.set(to, proposed);
                changed = true;
            }
        });
        if (!changed) break;
    }
    const connectedMax = Math.max(0, ...districtLayer.values());
    groupIds.forEach((id) => {
        if (!districtLayer.has(id))
            districtLayer.set(id, hasQuotientEdge.has(id) ? 0 : connectedMax + (connectedMax > 0 ? 1 : 0));
    });
    // Local change: a district (scope node) carrying an explicit
    // display.flowLayer overrides the quotient layering — generator-computed
    // bands (deploy hosts, producer rows) win over edge inference.
    groupIds.forEach((id) => {
        const explicit = scopeById.get(id)?.display?.flowLayer;
        if (explicit !== undefined) districtLayer.set(id, explicit);
    });
    const maxDistrictLayer = Math.max(...districtLayer.values(), 0);

    // Local change: stable, legible ordering — band (front to back), then
    // label. Drives both the rail listing and left-to-right order within rows.
    /**
     * Produces the human-readable name for a district.
     *
     * @param id - The district id.
     * @returns The scope's label, "Near <scope>" for satellite strips, or "System".
     */
    const groupLabel = (id: string) =>
        scopeById.get(id)?.label ??
        (id.startsWith("__near:") ? `Near ${scopeById.get(id.slice(7))?.label ?? ""}` : "System");
    districtEntries.sort(
        ([left], [right]) =>
            (districtLayer.get(left) ?? maxDistrictLayer) - (districtLayer.get(right) ?? maxDistrictLayer) ||
            groupLabel(left).localeCompare(groupLabel(right)),
    );

    // Local change: a district whose flow layers are all tiny (1-2 nodes each)
    // would pack as a skinny 1xN strip; flatten its layers and pack it square
    // instead, keeping layer order as the placement order.
    /**
     * Decides whether a district's flow layers should collapse into one, so a
     * district of many tiny layers packs square instead of as a skinny strip.
     *
     * @param districtNodes - The district's structures.
     * @returns True when every layer holds at most two nodes and flattening helps.
     */
    const flattenLayers = (districtNodes: CityNode[]) => {
        if (districtNodes.length < 4) return false;
        const counts = new Map<number, number>();
        districtNodes.forEach((node) => {
            const layer = globalLayerOf(node);
            counts.set(layer, (counts.get(layer) ?? 0) + 1);
        });
        return counts.size >= 2 && [...counts.values()].every((count) => count <= 2);
    };
    const flattened = new Map(districtEntries.map(([id, districtNodes]) => [id, flattenLayers(districtNodes)]));
    /**
     * A node's layer within its own district: zero everywhere in a flattened
     * district, the global layer otherwise.
     *
     * @param districtId - The district the node belongs to.
     * @param node - The node being placed.
     * @returns The layer index used for in-district depth packing.
     */
    const localLayerOf = (districtId: string, node: CityNode) => (flattened.get(districtId) ? 0 : globalLayerOf(node));

    const districtWidths = districtEntries.map(([id, districtNodes]) => {
        const largestCell = Math.max(
            ...[...new Set(districtNodes.map((node) => localLayerOf(id, node)))].map(
                (layer) => districtNodes.filter((node) => localLayerOf(id, node) === layer).length,
            ),
            1,
        );
        return Math.max(3.2, columnsFor(largestCell) * nodeStepX + 0.7);
    });
    /**
     * Looks up a district's computed plot width.
     *
     * @param index - Position in districtEntries.
     * @returns The width in world units.
     */
    const widthAt = (index: number): number => {
        const width = districtWidths[index];
        if (width === undefined) throw new Error("District width missing.");
        return width;
    };

    const rowMembers = new Map<number, number[]>();
    districtEntries.forEach((entry, index) => {
        const rowLayer = districtLayer.get(entry[0]) ?? maxDistrictLayer;
        rowMembers.set(rowLayer, [...(rowMembers.get(rowLayer) ?? []), index]);
    });

    // Local change: compact packing. Each district uses its OWN compacted layer
    // sequence for depth, and a layer's row stack gets real space — layers are
    // offset cumulatively by their row counts, so a deep front layer can never
    // land its rows on top of the next layer's nodes.
    const layerGap = 0.2;
    const localInfo = new Map<
        number,
        { layerIndex: Map<number, number>; layerOffsets: Map<number, number>; depth: number }
    >();
    districtEntries.forEach(([id, districtNodes], index) => {
        const uniqueLayers = [...new Set(districtNodes.map((node) => localLayerOf(id, node)))].sort((a, b) => a - b);
        const layerIndex = new Map(uniqueLayers.map((layer, position) => [layer, position]));
        const layerOffsets = new Map<number, number>();
        let offset = 0;
        for (const layer of uniqueLayers) {
            layerOffsets.set(layer, offset);
            const count = districtNodes.filter((node) => localLayerOf(id, node) === layer).length;
            const rows = Math.ceil(count / columnsFor(count));
            offset += rows * nodeStepZ + layerGap;
        }
        const depth = Math.max(0, offset - layerGap - nodeStepZ);
        localInfo.set(index, { layerIndex, layerOffsets, depth });
    });
    /**
     * Looks up a district's per-layer packing info (layer order, depth
     * offsets, and total depth).
     *
     * @param index - Position in districtEntries.
     * @returns The district's local layout info.
     */
    const infoAt = (index: number) => {
        const info = localInfo.get(index);
        if (info === undefined) throw new Error("District layout info missing.");
        return info;
    };

    // Local change: wrap over-wide rows (a map with no cross-district edges
    // would otherwise be one endless ribbon).
    const MAX_ROW_WIDTH = 64;
    const sortedRows: Array<[number, number[]]> = [];
    [...rowMembers.entries()]
        .sort((a, b) => a[0] - b[0])
        .forEach(([rowLayer, entryIndexes]) => {
            let chunk: number[] = [];
            let width = 0;
            let part = 0;
            for (const index of entryIndexes) {
                const step = widthAt(index) + (chunk.length ? districtGap : 0);
                if (chunk.length && width + step > MAX_ROW_WIDTH) {
                    sortedRows.push([rowLayer + part * 1e-3, chunk]);
                    part += 1;
                    chunk = [];
                    width = 0;
                }
                chunk.push(index);
                width += widthAt(index) + (chunk.length > 1 ? districtGap : 0);
            }
            if (chunk.length) sortedRows.push([rowLayer + part * 1e-3, chunk]);
        });
    const rowGap = 3.6;
    const rowBases = new Map<number, number>();
    let zCursor = 0;
    sortedRows.forEach(([rowLayer, entryIndexes]) => {
        rowBases.set(rowLayer, zCursor);
        const rowDepth = Math.max(...entryIndexes.map((index) => infoAt(index).depth), 0);
        zCursor -= rowDepth + rowGap;
    });
    const zShift = (-zCursor - rowGap) / 2;

    const positions = new Map<string, [number, number]>();
    for (const [rowLayer, entryIndexes] of sortedRows) {
        const rowWidth =
            entryIndexes.reduce((total, index) => total + widthAt(index), 0) +
            districtGap * Math.max(0, entryIndexes.length - 1);
        const rowBase = rowBases.get(rowLayer);
        if (rowBase === undefined) throw new Error("Row base missing for row layer.");
        const rowZ = rowBase + zShift;
        let districtCursor = -rowWidth / 2;
        for (const districtIndex of entryIndexes) {
            const districtEntry = districtEntries[districtIndex];
            if (districtEntry === undefined) throw new Error("District entry missing.");
            const [districtId, districtNodes] = districtEntry;
            const districtWidth = widthAt(districtIndex);
            const { layerOffsets } = infoAt(districtIndex);
            const centerX = districtCursor + districtWidth / 2;
            const localLayers = new Map<number, CityNode[]>();
            districtNodes.forEach((node) => {
                const layer = localLayerOf(districtId, node);
                localLayers.set(layer, [...(localLayers.get(layer) ?? []), node]);
            });
            for (const [layer, layerNodes] of localLayers) {
                // Flattened districts keep flow order as placement order: global
                // layer first, then flowOrder, then label.
                layerNodes.sort(
                    (a, b) =>
                        globalLayerOf(a) - globalLayerOf(b) ||
                        (a.display?.flowOrder ?? Number.MAX_SAFE_INTEGER) -
                            (b.display?.flowOrder ?? Number.MAX_SAFE_INTEGER) ||
                        a.label.localeCompare(b.label),
                );
                const columnCount = columnsFor(layerNodes.length);
                layerNodes.forEach((node, index) => {
                    const row = Math.floor(index / columnCount);
                    const column = index % columnCount;
                    const nodesInRow = Math.min(columnCount, layerNodes.length - row * columnCount);
                    const x = centerX + (column - (nodesInRow - 1) / 2) * nodeStepX;
                    const z = rowZ - (layerOffsets.get(layer) ?? 0) - row * nodeStepZ;
                    positions.set(node.id, [x, z]);
                });
            }
            districtCursor += districtWidth + districtGap;
        }
    }

    const districts = districtEntries.map(([id, districtNodes]) => {
        const districtExtents = districtNodes.map((node) => {
            const position = positions.get(node.id);
            if (position === undefined) throw new Error("Node missing from positions map.");
            const [x, z] = position;
            const [width, , depth] = node.display?.size ?? DEFAULT_FOOTPRINT;
            const hasInterior = allNodes.some((candidate) => candidate.parentId === node.id);
            const labelLength = node.label.length + (hasInterior ? 3 : 0);
            // Matches MapMarker's labelScale: campus nameplates render at 40%.
            const labelScale = 0.4;
            // Campus-scale nameplates only: the layout always draws the outside
            // view, so a node is a landmark when it has an interior, quieter when
            // external. The scene shares this mapping (plus the interior case).
            const variant = plaqueVariantFor({ interior: false, hasInterior, isExternal: node.kind === "external" });
            const plaque = plaqueMetrics(variant, labelLength);
            const plaqueWidth = plaque.width * labelScale;
            const plaqueHeight = plaque.height * labelScale;
            const footprintDepth = depth + 0.24;
            const plaqueFarZ = z + footprintDepth / 2 + plaqueHeight + 0.06;
            return {
                minX: Math.min(x - width / 2, x - plaqueWidth / 2),
                maxX: Math.max(x + width / 2, x + plaqueWidth / 2),
                minZ: z - depth / 2,
                maxZ: plaqueFarZ,
            };
        });
        const scope = scopeById.get(id);
        const nearScope = id.startsWith("__near:") ? scopeById.get(id.slice(7)) : undefined;
        return {
            id,
            label: scope?.label ?? (nearScope ? `Near ${nearScope.label}` : "System"),
            color: scope?.display?.color,
            band: districtLayer.get(id) ?? 0,
            bandLabel: scope?.tags?.find((tag) => tag.startsWith("band:"))?.slice(5),
            description: scope?.description,
            nodeIds: districtNodes.map((node) => node.id),
            bounds: {
                minX: Math.min(...districtExtents.map((extent) => extent.minX)) - 0.35,
                maxX: Math.max(...districtExtents.map((extent) => extent.maxX)) + 0.35,
                minZ: Math.min(...districtExtents.map((extent) => extent.minZ)) - 0.45,
                // The front edge keeps room for the district sign (0.78 + inset).
                maxZ: Math.max(...districtExtents.map((extent) => extent.maxZ)) + 1.3,
            },
        };
    });

    const districtBounds = districts.map((district) => district.bounds);
    const bounds = {
        minX: Math.min(...districtBounds.map((item) => item.minX)),
        maxX: Math.max(...districtBounds.map((item) => item.maxX)),
        minZ: Math.min(...districtBounds.map((item) => item.minZ)),
        maxZ: Math.max(...districtBounds.map((item) => item.maxZ)) + 0.65,
    };

    return {
        positions,
        layers,
        districts,
        bounds,
    };
}

// Local addition: deterministic ground-plane edge routing. Edges route around
// buildings and prefer the gaps between district plots instead of cutting
// straight through them. A* on a coarse grid with a turn penalty keeps the
// paths Manhattan-like; building cells are near-impassable, district
// interiors carry a soft penalty (endpoints still need to get in and out).
// The grid build is selection-independent, so the router is a factory: build
// once per layout, route individual edges on demand (cached per edge id).
// Import edges are routed lazily this way when a node is selected.
export type EdgeRouter = { route: (edge: CityEdge) => Array<[number, number]> | null };
/**
 * Builds the edge router for a computed layout: rasterises district plots and
 * building footprints into a cost grid once, then routes individual edges on
 * demand with A*, caching each result by edge id.
 *
 * @param layout - The layout whose positions and bounds the grid covers.
 * @param allNodes - Nodes whose rendered footprints become obstacles.
 * @returns A router whose route() yields the simplified ground-plane waypoints
 *   for an edge, or null when no path exists (or the map is absurdly large).
 */
export function createEdgeRouter(layout: FlowLayout, allNodes: CityNode[]): EdgeRouter {
    const cache = new Map<string, Array<[number, number]> | null>();
    const cell = 0.45;
    const margin = 3;
    const minX = layout.bounds.minX - margin;
    const maxX = layout.bounds.maxX + margin;
    const minZ = layout.bounds.minZ - margin;
    const maxZ = layout.bounds.maxZ + margin;
    const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
    const rows = Math.max(1, Math.ceil((maxZ - minZ) / cell));
    if (cols * rows > 600_000) return { route: () => null }; // absurd map: keep the simple paths

    const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
    const columnOf = (x: number) => clamp(Math.floor((x - minX) / cell), 0, cols - 1);
    const rowOf = (z: number) => clamp(Math.floor((z - minZ) / cell), 0, rows - 1);
    const indexOf = (column: number, row: number) => row * cols + column;
    const worldOf = (index: number): [number, number] => [
        minX + (index % cols) * cell + cell / 2,
        minZ + Math.floor(index / cols) * cell + cell / 2,
    ];

    const DISTRICT_COST = 3;
    const BUILDING_COST = 200;
    const TURN_COST = 2.5;

    const cost = new Float32Array(cols * rows).fill(1);
    /**
     * Stamps a rectangle into the cost grid, raising each covered cell to at
     * least the given traversal cost.
     *
     * @param bounds - The world-space rectangle to stamp.
     * @param value - The traversal cost to impose within it.
     * @param cells - Optional set that collects the covered cell indices.
     */
    const rasterise = (
        bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
        value: number,
        cells?: Set<number>,
    ) => {
        for (let row = rowOf(bounds.minZ); row <= rowOf(bounds.maxZ); row += 1) {
            for (let column = columnOf(bounds.minX); column <= columnOf(bounds.maxX); column += 1) {
                const index = indexOf(column, row);
                const current = cost[index];
                if (current === undefined) continue;
                cost[index] = Math.max(current, value);
                cells?.add(index);
            }
        }
    };

    for (const district of layout.districts) {
        if (district.id.startsWith("__")) continue;
        rasterise(district.bounds, DISTRICT_COST);
    }
    const nodeCells = new Map<string, Set<number>>();
    for (const node of allNodes) {
        const position = layout.positions.get(node.id);
        if (!position) continue;
        // Obstacles use the on-ground footprint marker's extent (the plot a
        // viewer sees, MARKER_FOOTPRINT_SCALE) with a slim pad, so the corridors
        // between tightly packed buildings stay open. The Structure mesh itself
        // draws smaller (see RepoCity's structureScale); the marker, not the
        // mesh, is what the routes should thread between.
        const [width, , depth] = (node.display?.size ?? DEFAULT_FOOTPRINT).map((d) => d * MARKER_FOOTPRINT_SCALE) as [
            number,
            number,
            number,
        ];
        const pad = 0.12;
        const cells = new Set<number>();
        rasterise(
            {
                minX: position[0] - width / 2 - pad,
                maxX: position[0] + width / 2 + pad,
                minZ: position[1] - depth / 2 - pad,
                maxZ: position[1] + depth / 2 + pad,
            },
            BUILDING_COST,
            cells,
        );
        nodeCells.set(node.id, cells);
    }

    // Binary min-heap over [priority, state] pairs.
    const heapPriority: number[] = [];
    const heapState: number[] = [];
    /**
     * Pushes a search state onto the min-heap and sifts it up.
     *
     * @param priority - The A* f-score (cost so far plus heuristic).
     * @param state - The encoded cell-and-direction state.
     */
    const heapPush = (priority: number, state: number) => {
        let i = heapPriority.length;
        heapPriority.push(priority);
        heapState.push(state);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            const parentPriority = heapPriority[parent];
            const currentPriority = heapPriority[i];
            const parentState = heapState[parent];
            const currentState = heapState[i];
            if (
                parentPriority === undefined ||
                currentPriority === undefined ||
                parentState === undefined ||
                currentState === undefined
            )
                break;
            if (parentPriority <= currentPriority) break;
            heapPriority[parent] = currentPriority;
            heapPriority[i] = parentPriority;
            heapState[parent] = currentState;
            heapState[i] = parentState;
            i = parent;
        }
    };
    /**
     * Removes the lowest-priority state from the min-heap and re-heapifies.
     *
     * @returns The encoded cell-and-direction state with the smallest f-score.
     */
    const heapPop = (): number => {
        const top = heapState[0];
        const lastPriority = heapPriority.pop();
        const lastState = heapState.pop();
        if (top === undefined || lastPriority === undefined || lastState === undefined) {
            throw new Error("Heap pop on empty heap.");
        }
        if (heapPriority.length) {
            heapPriority[0] = lastPriority;
            heapState[0] = lastState;
            let i = 0;
            for (;;) {
                const left = i * 2 + 1;
                const right = left + 1;
                let smallest = i;
                const currentPriority = heapPriority[i];
                if (currentPriority === undefined) break;
                let smallestPriority = currentPriority;
                const leftPriority = heapPriority[left];
                if (left < heapPriority.length && leftPriority !== undefined && leftPriority < smallestPriority) {
                    smallest = left;
                    smallestPriority = leftPriority;
                }
                const rightPriority = heapPriority[right];
                if (right < heapPriority.length && rightPriority !== undefined && rightPriority < smallestPriority) {
                    smallest = right;
                    smallestPriority = rightPriority;
                }
                if (smallest === i) break;
                const smallestState = heapState[smallest];
                const currentState = heapState[i];
                if (smallestState === undefined || currentState === undefined) break;
                heapPriority[smallest] = currentPriority;
                heapPriority[i] = smallestPriority;
                heapState[smallest] = currentState;
                heapState[i] = smallestState;
                i = smallest;
            }
        }
        return top;
    };

    const DX = [1, -1, 0, 0];
    const DZ = [0, 0, 1, -1];

    /**
     * Routes one edge across the cost grid with turn-penalised A*, exempting
     * the endpoint buildings' own cells so paths can leave and arrive.
     *
     * @param edge - The edge to route; results are cached by edge id.
     * @returns Simplified [x, z] waypoints from source to target (exact
     *   endpoints, collinear runs collapsed), or null when unroutable.
     */
    const route = (edge: CityEdge): Array<[number, number]> | null => {
        const cached = cache.get(edge.id);
        if (cached !== undefined) return cached;
        if (cache.has(edge.id)) return null;
        cache.set(edge.id, null);
        const from = layout.positions.get(edge.from);
        const to = layout.positions.get(edge.to);
        if (!from || !to) return null;
        const exempt = new Set<number>([...(nodeCells.get(edge.from) ?? []), ...(nodeCells.get(edge.to) ?? [])]);
        const startIndex = indexOf(columnOf(from[0]), rowOf(from[1]));
        const goalIndex = indexOf(columnOf(to[0]), rowOf(to[1]));
        const goalColumn = goalIndex % cols;
        const goalRow = Math.floor(goalIndex / cols);
        // State: cell * 4 + incoming direction (direction 0 seeds the start).
        const best = new Map<number, number>();
        const cameFrom = new Map<number, number>();
        heapPriority.length = 0;
        heapState.length = 0;
        for (let direction = 0; direction < 4; direction += 1) {
            const state = startIndex * 4 + direction;
            best.set(state, 0);
            heapPush(0, state);
        }
        let goalState = -1;
        let expansions = 0;
        while (heapPriority.length && expansions < 150_000) {
            expansions += 1;
            const state = heapPop();
            const index = state >> 2;
            const direction = state & 3;
            if (index === goalIndex) {
                goalState = state;
                break;
            }
            const g = best.get(state);
            if (g === undefined) continue;
            const column = index % cols;
            const row = Math.floor(index / cols);
            for (let next = 0; next < 4; next += 1) {
                const stepX = DX[next];
                const stepZ = DZ[next];
                if (stepX === undefined || stepZ === undefined) continue;
                const nextColumn = column + stepX;
                const nextRow = row + stepZ;
                if (nextColumn < 0 || nextColumn >= cols || nextRow < 0 || nextRow >= rows) continue;
                const nextIndex = indexOf(nextColumn, nextRow);
                const stepCost = exempt.has(nextIndex) ? 1 : cost[nextIndex];
                if (stepCost === undefined) continue;
                const nextG = g + stepCost + (next === direction ? 0 : TURN_COST);
                const nextState = nextIndex * 4 + next;
                if ((best.get(nextState) ?? Infinity) <= nextG) continue;
                best.set(nextState, nextG);
                cameFrom.set(nextState, state);
                const h = Math.abs(nextColumn - goalColumn) + Math.abs(nextRow - goalRow);
                heapPush(nextG + h, nextState);
            }
        }
        if (goalState < 0) return null;
        const cellPath: number[] = [];
        for (let state: number | undefined = goalState; state !== undefined; state = cameFrom.get(state)) {
            cellPath.push(state >> 2);
        }
        cellPath.reverse();
        // Exact endpoints, grid cells between, collinear runs collapsed.
        const waypoints: Array<[number, number]> = [from, ...cellPath.map(worldOf), to];
        const simplified: Array<[number, number]> = [from];
        for (let i = 1; i < waypoints.length - 1; i += 1) {
            const previous = simplified[simplified.length - 1];
            const current = waypoints[i];
            const following = waypoints[i + 1];
            if (previous === undefined || current === undefined || following === undefined) continue;
            const collinear =
                (Math.abs(previous[0] - current[0]) < 1e-6 && Math.abs(current[0] - following[0]) < 1e-6) ||
                (Math.abs(previous[1] - current[1]) < 1e-6 && Math.abs(current[1] - following[1]) < 1e-6);
            if (!collinear) simplified.push(current);
        }
        simplified.push(to);
        cache.set(edge.id, simplified);
        return simplified;
    };
    return { route };
}
