// Flow layering: front-to-back rows for the rendered city, by longest path
// from the entry nodes (HEURISTICS.md rule M2).

/**
 * Longest-path layering over "from->to" edge keys: entry ids (or all ids when
 * none are given) start at layer 0 and every edge pushes its target at least
 * one deeper, capped at the id count; unreached ids default to 0.
 *
 * @param ids - The node ids to layer; ids absent from any edge stay at 0.
 * @param edges - Edge map whose keys are "from->to" pairs (values unused).
 * @param entries - The entry-node ids seeding layer 0; when empty, every id
 *   seeds instead.
 * @returns Each id's flow layer (0 = front row, deeper = further back).
 */
export function layerByLongestPath(
    ids: readonly string[],
    edges: ReadonlyMap<string, unknown>,
    entries: readonly string[],
): Map<string, number> {
    const layers = new Map<string, number>();
    for (const id of entries.length ? entries : ids) layers.set(id, 0);
    for (let pass = 0; pass < ids.length + 1; pass += 1) {
        let changed = false;
        for (const key of edges.keys()) {
            const [from = "", to = ""] = key.split("->");
            const fromLayer = layers.get(from);
            if (fromLayer === undefined || !ids.includes(to)) continue;
            const proposed = fromLayer + 1;
            const existing = layers.get(to);
            if ((existing === undefined || existing < proposed) && proposed <= ids.length) {
                layers.set(to, proposed);
                changed = true;
            }
        }
        if (!changed) break;
    }
    for (const id of ids) if (!layers.has(id)) layers.set(id, 0);
    return layers;
}
