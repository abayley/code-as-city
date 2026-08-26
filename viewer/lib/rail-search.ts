// The sidebar rail's search rule, extracted so the rail's tests exercise the
// same predicate the viewer uses rather than restating it.

/** The node fields the rail search reads. */
export type RailSearchable = {
    label: string;
    kind: string;
    description?: string | undefined;
};

/**
 * Tests whether a node matches the rail's search box. The term is matched
 * case-insensitively as a substring of the node's label, kind and description
 * joined by spaces, so searching "worker" finds nodes by archetype as well as
 * by name. The term is not trimmed: an empty box matches everything, and a
 * term with spaces matches across the joined fields.
 *
 * @param node - The node's searchable fields.
 * @param search - The raw contents of the search box.
 * @returns Whether the node should stay visible in the rail.
 */
export function matchesRailSearch(node: RailSearchable, search: string): boolean {
    return `${node.label} ${node.kind} ${node.description ?? ""}`.toLowerCase().includes(search.toLowerCase());
}
