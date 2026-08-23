import type { CityEdge, CityNode } from "./city-map";

export type FlowLayout = {
  positions: Map<string, [number, number]>;
  layers: Map<string, number>;
  neighborhoods: Array<{
    id: string;
    label: string;
    color?: string;
    band?: number;
    bandLabel?: string;
    description?: string;
    nodeIds: string[];
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  }>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

const STAGE_HINTS: Array<[RegExp, number]> = [
  [/\b(ui|ux|frontend|front-end|web app|client|public api|sdk|command|cli|ingress|gateway|http|graphql|rest|entry|input)\b/i, 0],
  [/\b(router|route|controller|orchestrat|service|server|handler|dispatcher|api server)\b/i, 1],
  [/\b(core|domain|engine|compiler|reconciler|processor|transform|model|planner|scheduler|runtime)\b/i, 2],
  [/\b(worker|job|consumer|queue|stream|event|background|replication|controller manager)\b/i, 3],
  [/\b(database|postgres|mysql|sqlite|redis|cache|storage|bucket|filesystem|persistence|etcd|warehouse|index)\b/i, 4],
];

function hintedStage(node: CityNode) {
  if (Number.isInteger(node.display?.flowLayer)) return Math.max(0, node.display!.flowLayer!);
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

function flowEdges(nodes: CityNode[], edges: CityEdge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const primary = edges.filter((edge) => edge.kind !== "deploys" && ids.has(edge.from) && ids.has(edge.to));
  return primary.length ? primary : edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

export function computeFlowLayout(nodes: CityNode[], edges: CityEdge[], allNodes: CityNode[]): FlowLayout {
  if (!nodes.length) {
    return { positions: new Map(), layers: new Map(), neighborhoods: [], bounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 } };
  }

  const relevantEdges = flowEdges(nodes, edges);
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  relevantEdges.forEach((edge) => {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  });

  let entries = nodes.filter((node) =>
    node.display?.flowLayer === 0 ||
    (hintedStage(node) === 0 && node.kind !== "external") ||
    ((incoming.get(node.id) ?? 0) === 0 && (outgoing.get(node.id)?.length ?? 0) > 0 && node.kind !== "infra" && node.kind !== "external"),
  );
  if (!entries.length) {
    const firstStage = Math.min(...nodes.map(hintedStage));
    entries = nodes.filter((node) => hintedStage(node) === firstStage);
  }

  const distance = new Map<string, number>();
  const queue = entries.map((node) => node.id);
  queue.forEach((id) => distance.set(id, 0));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const from = queue[cursor];
    const nextDistance = (distance.get(from) ?? 0) + 1;
    for (const to of outgoing.get(from) ?? []) {
      if (!distance.has(to) || nextDistance < distance.get(to)!) {
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
  const layers = new Map([...rawLayers].map(([id, layer]) => [id, compactLayer.get(layer)!]));
  const maxLayer = Math.max(...layers.values(), 0);

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
  const neighborhoodFor = (node: CityNode) => node.parentId && scopeById.has(node.parentId)
    ? node.parentId
    : affinity.has(node.id) ? `__near:${affinity.get(node.id)}` : "__system";
  const neighborhoodRank = (id: string) => {
    if (scopeOrder.has(id)) return scopeOrder.get(id)! * 2;
    if (id.startsWith("__near:")) return (scopeOrder.get(id.slice(7)) ?? Number.MAX_SAFE_INTEGER / 4) * 2 + 1;
    return Number.MAX_SAFE_INTEGER;
  };
  const groupedNodes = new Map<string, CityNode[]>();
  nodes.forEach((node) => {
    const neighborhoodId = neighborhoodFor(node);
    groupedNodes.set(neighborhoodId, [...(groupedNodes.get(neighborhoodId) ?? []), node]);
  });
  const neighborhoodEntries = [...groupedNodes].sort(([left], [right]) =>
    neighborhoodRank(left) - neighborhoodRank(right) || left.localeCompare(right),
  );
  const nodeStepX = 2.0;
  const nodeStepZ = 1.7;
  // Local change: districts grow roughly square instead of two fixed columns.
  const columnsFor = (count: number) => Math.max(1, Math.ceil(Math.sqrt(count)));
  const layerStepZ = 5.5;
  // Local change: tighter packing for many-district maps. A single-structure
  // neighbourhood only needs its own footprint, and the gap between
  // neighbourhoods is decorative, not structural.
  const neighborhoodGap = 0.9;

  // Local change: district-level flow layering. Districts themselves are
  // layered by their cross-district edges (producers in front, consumers
  // behind) and laid out in rows instead of one long ribbon. Groups with no
  // cross-district edges at all go to the back row.
  const neighborhoodOf = new Map<string, string>();
  nodes.forEach((node) => neighborhoodOf.set(node.id, neighborhoodFor(node)));
  const quotientEdges = new Set<string>();
  relevantEdges.forEach((edge) => {
    const from = neighborhoodOf.get(edge.from);
    const to = neighborhoodOf.get(edge.to);
    if (from && to && from !== to) quotientEdges.add(`${from}=>${to}`);
  });
  const groupIds = neighborhoodEntries.map(([id]) => id);
  const hasQuotientEdge = new Set([...quotientEdges].flatMap((key) => key.split("=>")));
  const incomingCount = new Map(groupIds.map((id) => [id, 0]));
  quotientEdges.forEach((key) => {
    const to = key.split("=>")[1];
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
      if (!districtLayer.has(from)) return;
      const proposed = districtLayer.get(from)! + 1;
      if ((districtLayer.get(to) ?? -1) < proposed && proposed <= groupIds.length) {
        districtLayer.set(to, proposed);
        changed = true;
      }
    });
    if (!changed) break;
  }
  const connectedMax = Math.max(0, ...districtLayer.values());
  groupIds.forEach((id) => {
    if (!districtLayer.has(id)) districtLayer.set(id, hasQuotientEdge.has(id) ? 0 : connectedMax + (connectedMax > 0 ? 1 : 0));
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
  const groupLabel = (id: string) => scopeById.get(id)?.label
    ?? (id.startsWith("__near:") ? `Near ${scopeById.get(id.slice(7))?.label ?? ""}` : "System");
  neighborhoodEntries.sort(([left], [right]) =>
    (districtLayer.get(left) ?? maxDistrictLayer) - (districtLayer.get(right) ?? maxDistrictLayer)
    || groupLabel(left).localeCompare(groupLabel(right)));

  // Local change: a district whose flow layers are all tiny (1-2 nodes each)
  // would pack as a skinny 1xN strip; flatten its layers and pack it square
  // instead, keeping layer order as the placement order.
  const flattenLayers = (neighborhoodNodes: CityNode[]) => {
    if (neighborhoodNodes.length < 4) return false;
    const counts = new Map<number, number>();
    neighborhoodNodes.forEach((node) => {
      const layer = layers.get(node.id)!;
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
    });
    return counts.size >= 2 && [...counts.values()].every((count) => count <= 2);
  };
  const flattened = new Map(neighborhoodEntries.map(([id, neighborhoodNodes]) => [id, flattenLayers(neighborhoodNodes)]));
  const localLayerOf = (neighborhoodId: string, node: CityNode) =>
    flattened.get(neighborhoodId) ? 0 : layers.get(node.id)!;

  const neighborhoodWidths = neighborhoodEntries.map(([id, neighborhoodNodes]) => {
    const largestCell = Math.max(...[...new Set(neighborhoodNodes.map((node) => localLayerOf(id, node)))]
      .map((layer) => neighborhoodNodes.filter((node) => localLayerOf(id, node) === layer).length), 1);
    return Math.max(3.2, columnsFor(largestCell) * nodeStepX + 0.7);
  });

  const rowMembers = new Map<number, number[]>();
  neighborhoodEntries.forEach((entry, index) => {
    const rowLayer = districtLayer.get(entry[0]) ?? maxDistrictLayer;
    rowMembers.set(rowLayer, [...(rowMembers.get(rowLayer) ?? []), index]);
  });

  // Local change: compact packing. Each district uses its OWN compacted layer
  // sequence for depth, and a layer's row stack gets real space — layers are
  // offset cumulatively by their row counts, so a deep front layer can never
  // land its rows on top of the next layer's nodes.
  const layerGap = 0.2;
  const localInfo = new Map<number, { layerIndex: Map<number, number>; layerOffsets: Map<number, number>; depth: number }>();
  neighborhoodEntries.forEach(([id, neighborhoodNodes], index) => {
    const uniqueLayers = [...new Set(neighborhoodNodes.map((node) => localLayerOf(id, node)))].sort((a, b) => a - b);
    const layerIndex = new Map(uniqueLayers.map((layer, position) => [layer, position]));
    const layerOffsets = new Map<number, number>();
    let offset = 0;
    for (const layer of uniqueLayers) {
      layerOffsets.set(layer, offset);
      const count = neighborhoodNodes.filter((node) => localLayerOf(id, node) === layer).length;
      const rows = Math.ceil(count / columnsFor(count));
      offset += rows * nodeStepZ + layerGap;
    }
    const depth = Math.max(0, offset - layerGap - nodeStepZ);
    localInfo.set(index, { layerIndex, layerOffsets, depth });
  });

  // Local change: wrap over-wide rows (a map with no cross-district edges
  // would otherwise be one endless ribbon).
  const MAX_ROW_WIDTH = 64;
  const sortedRows: Array<[number, number[]]> = [];
  [...rowMembers.entries()].sort((a, b) => a[0] - b[0]).forEach(([rowLayer, entryIndexes]) => {
    let chunk: number[] = [];
    let width = 0;
    let part = 0;
    for (const index of entryIndexes) {
      const step = neighborhoodWidths[index] + (chunk.length ? neighborhoodGap : 0);
      if (chunk.length && width + step > MAX_ROW_WIDTH) {
        sortedRows.push([rowLayer + part * 1e-3, chunk]);
        part += 1;
        chunk = [];
        width = 0;
      }
      chunk.push(index);
      width += neighborhoodWidths[index] + (chunk.length > 1 ? neighborhoodGap : 0);
    }
    if (chunk.length) sortedRows.push([rowLayer + part * 1e-3, chunk]);
  });
  const rowGap = 3.6;
  const rowBases = new Map<number, number>();
  let zCursor = 0;
  sortedRows.forEach(([rowLayer, entryIndexes]) => {
    rowBases.set(rowLayer, zCursor);
    const rowDepth = Math.max(...entryIndexes.map((index) => localInfo.get(index)!.depth), 0);
    zCursor -= rowDepth + rowGap;
  });
  const zShift = (-zCursor - rowGap) / 2;

  const positions = new Map<string, [number, number]>();
  for (const [rowLayer, entryIndexes] of sortedRows) {
    const rowWidth = entryIndexes.reduce((total, index) => total + neighborhoodWidths[index], 0)
      + neighborhoodGap * Math.max(0, entryIndexes.length - 1);
    const rowZ = rowBases.get(rowLayer)! + zShift;
    let neighborhoodCursor = -rowWidth / 2;
    for (const neighborhoodIndex of entryIndexes) {
      const [, neighborhoodNodes] = neighborhoodEntries[neighborhoodIndex];
      const neighborhoodWidth = neighborhoodWidths[neighborhoodIndex];
      const { layerOffsets } = localInfo.get(neighborhoodIndex)!;
      const centerX = neighborhoodCursor + neighborhoodWidth / 2;
      const [neighborhoodId] = neighborhoodEntries[neighborhoodIndex];
      const localLayers = new Map<number, CityNode[]>();
      neighborhoodNodes.forEach((node) => {
        const layer = localLayerOf(neighborhoodId, node);
        localLayers.set(layer, [...(localLayers.get(layer) ?? []), node]);
      });
      for (const [layer, layerNodes] of localLayers) {
        // Flattened districts keep flow order as placement order: global
        // layer first, then flowOrder, then label.
        layerNodes.sort((a, b) =>
          layers.get(a.id)! - layers.get(b.id)!
          || (a.display?.flowOrder ?? Number.MAX_SAFE_INTEGER) - (b.display?.flowOrder ?? Number.MAX_SAFE_INTEGER)
          || a.label.localeCompare(b.label),
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
      neighborhoodCursor += neighborhoodWidth + neighborhoodGap;
    }
  }

  const neighborhoods = neighborhoodEntries.map(([id, neighborhoodNodes]) => {
    const neighborhoodExtents = neighborhoodNodes.map((node) => {
      const [x, z] = positions.get(node.id)!;
      const [width, , depth] = node.display?.size ?? [1.65, 1.2, 1.4];
      const hasInterior = allNodes.some((candidate) => candidate.parentId === node.id);
      const labelLength = node.label.length + (hasInterior ? 3 : 0);
      // Matches MapMarker's labelScale: campus nameplates render at 40%.
      const labelScale = 0.4;
      const plaqueWidth = (hasInterior
        ? Math.max(3.15, Math.min(4.7, 2.1 + labelLength * 0.065))
        : node.kind === "external"
          ? Math.max(2.35, Math.min(3.65, 1.75 + labelLength * 0.05))
          : Math.max(2.6, Math.min(4.1, 1.9 + labelLength * 0.058))) * labelScale;
      const plaqueHeight = (hasInterior ? 1.02 : node.kind === "external" ? 0.76 : 0.88) * labelScale;
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
      nodeIds: neighborhoodNodes.map((node) => node.id),
      bounds: {
        minX: Math.min(...neighborhoodExtents.map((extent) => extent.minX)) - 0.35,
        maxX: Math.max(...neighborhoodExtents.map((extent) => extent.maxX)) + 0.35,
        minZ: Math.min(...neighborhoodExtents.map((extent) => extent.minZ)) - 0.45,
        // The front edge keeps room for the district sign (0.78 + inset).
        maxZ: Math.max(...neighborhoodExtents.map((extent) => extent.maxZ)) + 1.3,
      },
    };
  });

  const neighborhoodBounds = neighborhoods.map((neighborhood) => neighborhood.bounds);
  const bounds = {
    minX: Math.min(...neighborhoodBounds.map((item) => item.minX)),
    maxX: Math.max(...neighborhoodBounds.map((item) => item.maxX)),
    minZ: Math.min(...neighborhoodBounds.map((item) => item.minZ)),
    maxZ: Math.max(...neighborhoodBounds.map((item) => item.maxZ)) + 0.65,
  };

  return {
    positions,
    layers,
    neighborhoods,
    bounds,
  };
}

export function flowStageLabel(layer: number, maxLayer: number) {
  if (layer === 0) return "Entry points";
  if (layer === maxLayer) return "State & external";
  const ratio = layer / Math.max(1, maxLayer);
  if (ratio <= 0.34) return "Orchestration";
  if (ratio <= 0.68) return "Core compute";
  return "Runtime & data";
}
