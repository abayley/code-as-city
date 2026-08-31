---
id: REVIEW-0006
name: Code review of candidate 5 (extract the campus projection)
status: Complete
owners:
    - alistairbayley
created: 2026-08-31
updated: 2026-08-31
reviews: working tree vs 9bf6cae
---

# Code review of candidate 5 (extract the campus projection)

| Stage     | Timestamp  |
| --------- | ---------- |
| Authored  | 2026-08-31 |
| Completed | 2026-08-31 |

## Review Scope

The change set is uncommitted in the working tree; HEAD equals the fixed point
`9bf6cae`, so the review diffs the working tree against that commit. Reviewed on
the two axes the `code-review` skill covers, run as parallel sub-agents:

- **Standards** — conformance to the repo's documented conventions (British
  spelling, no emoji, TSDoc on exports, strict TS, ESM, kebab-case, the
  `bun run check` gate, deep modules with small interfaces, the deletion test)
  plus the Fowler smell baseline.
- **Spec** — fidelity to candidate 5 in
  [review-0002-architecture-20260830.html](review-0002-architecture-20260830.html)
  (lines 264-290), "Extract the campus projection".

Context: candidate 1 (a prior commit) had already moved `closestVisibleAncestor`,
`firstCampusConnection`, and `connectionBetween` into `navigation.ts`, so the
card's original five-piece list is already partly extracted; candidate 5 as
implemented is correspondingly narrower.

Files under review:

- NEW `viewer/lib/projection.ts` — `projectToVisible(map)`,
  `closestVisibleAncestor` (moved here from `navigation.ts`), the private
  `isCampusNode`, the evidence-priority edge dedup, and the `CampusProjection`
  / `AncestorLookup` types.
- NEW `test/unit/viewer/projection.test.ts` — characterisation tests.
- MOD `viewer/lib/navigation.ts` — imports `closestVisibleAncestor` from
  `projection.ts` instead of defining it.
- MOD `viewer/RepoCity.tsx` — replaces the inline
  `nodeById`/`isCampusNode`/`visibleIds`/`visibleEdges` block with
  `projectToVisible(map)`; the two ancestor lookups call `projection.ancestorOf`.
- MOD `test/unit/viewer/navigation.test.ts` — the `closestVisibleAncestor`
  cases move to `projection.test.ts`.

The change is viewer-side, so it is not covered by the generator's golden test;
it was verified in the browser preview (campus render, focus mode reporting the
projected connection count, zero console errors).

The two axes are reported separately below and deliberately not merged or
re-ranked; a change can pass one axis and fail the other.

## Standards

### Standards hard violations

None. TSDoc on every exported symbol (`AncestorLookup`, `closestVisibleAncestor`,
`CampusProjection`, `projectToVisible`); British spelling; kebab-case filename;
no `any`/ignores; ESM with type-only imports separated. `isCampusNode` is kept
module-private (not exported) — correct per "Do not expose helpers". Tooling
passes.

### Deletion test — projection.ts earns its place

Yes. Inlining `projectToVisible` back into `MapViewer` reinstates four
`useMemo`/`useCallback` blocks (nodeById, isCampusNode, visibleIds, the ~12-line
evidence-priority edge dedup); the complexity reappears across callers (both the
component and the navigation machine need `closestVisibleAncestor`), so it is
earning its keep, not a pass-through. It also thins the imperative shell toward a
pure core.

### Interface — CampusProjection

Coherent and narrow: `nodes`/`ids`/`edges` are the three campus-level products;
`ancestorOf` is the projection's own walk pre-bound to its lookup (removing the
`navContext` threading the old RepoCity code needed). One borderline member —
`nodeById` indexes *every* node (rooms included), a lower-abstraction escape
hatch alongside three campus-level fields — but it is documented ("rooms
included") and genuinely consumed. Not a grab-bag.

### Home of closestVisibleAncestor

Moving it `navigation.ts` → `projection.ts` is the right home (the ancestor walk
exists *for* edge projection). The dependency now points navigation → projection
and is acyclic (projection imports only from `city-map`). `navigation.ts`
imports and uses it internally, adding its own behaviour — not a Middle Man. The
export is required by `navigation.ts`, not test-only, so it stays public.

### Standards judgement calls (baseline smells)

1. **Divergent Change (mild).** `AncestorLookup` and the standalone
   `closestVisibleAncestor` export are public; production callers reach the walk
   via `ancestorOf`, but `navigation.ts` imports `closestVisibleAncestor`
   directly, so the export earns its place (it is not test-only). Noted, no
   action.

No Duplicated Code (the inline dedup is now single-sourced), no Feature Envy, no
Speculative Generality.

## Spec

Verdict: faithful, behaviour-preserving. One substantive gap (`edgesTouching`).

### Spec missing or partial requirements

- **`edgesTouching` omitted.** Spec:
  `projectToVisible(map, visibleIds) -> { nodes, edges, ancestorOf,
  edgesTouching }`. The projection returns no `edgesTouching`; the "edges
  touching the focused node" concern stays inline in RepoCity
  (`visibleEdges.filter((edge) => edge.from === activeFocusId || edge.to ===
  activeFocusId)`). Given HC-011's node-collapsing benefit ("HC-011 … will need
  exactly this seam"), leaving edge-adjacency out is a defensible narrowing but
  a real deviation from the stated output shape, and it is not test-covered.
  **Remediated below.**
- **Signature `projectToVisible(map)` vs `projectToVisible(map, visibleIds)` —
  faithful.** `visibleIds` was a card input; here it is *derived* from
  `isCampusNode` inside the projection, so passing what the module must compute
  would be redundant. Documented. Acceptable reading given candidate 1 shipped.

### Spec scope creep

None. `firstCampusConnection`/`connectionBetween` correctly stay in
`navigation.ts` (they operate on raw map edges); `closestVisibleAncestor` is
*moved* (not duplicated) with no logic added.

### Spec implemented-but-wrong

None found. `isCampusNode` logic is byte-identical; the `visibleEdges` dedup
(same `evidencePriority`, self-loop/no-ancestor drop, `campus:<from>-><to>` id)
is verbatim; `selectedConnectionFrom/To` via `ancestorOf` binds the same campus
`ids` the old `navContext.visibleIds` carried — equivalent.

### Benefit delivered

Yes. `projection.test.ts` asserts the evidence dedup (observed > declared >
inferred), self-loop dropping, campus-node selection, and the ancestor walk
(including the null-when-hidden case migrated from `navigation.test.ts`) — the
previously-untested logic now under test with plain CityMap fixtures.

## Summary

- **Standards:** 0 hard violations; 1 mild judgement call (the public
  `closestVisibleAncestor`/`AncestorLookup`, which earn their export via
  `navigation.ts`). Module earns its place; interface coherent.
- **Spec:** faithful and behaviour-preserving; 0 scope creep, 0
  implemented-but-wrong. Worst within axis: the un-extracted `edgesTouching`, a
  defensible narrowing but a real gap from the card's output shape.

## Resolution (2026-08-31)

Applied in the same working tree before commit, behaviour-preserving
(`bun run check` green; browser preview re-verified):

- **`edgesTouching` extracted (spec gap closed).** Added `edgesTouching(nodeId)`
  to `CampusProjection` — the projected edges where the node is an endpoint — and
  routed RepoCity's `focusConnections` through it instead of the inline filter.
  The projection's output shape now matches the card, and the adjacency query is
  covered by a `projection.test.ts` case.

Left as-is (judgement call, not a defect): the public
`closestVisibleAncestor`/`AncestorLookup`, which `navigation.ts` consumes
directly, and `nodeById` exposing every node for the ancestor walk (documented,
consumed).
