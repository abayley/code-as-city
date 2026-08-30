---
id: REVIEW-0004
name: Code review of candidate 1 (extract the viewer's navigation machine)
status: Complete
owners:
    - alistairbayley
created: 2026-08-31
updated: 2026-08-31
reviews: fde2a6d vs 4fe4b96
---

# Code review of candidate 1 (extract the viewer's navigation machine)

| Stage     | Timestamp  |
| --------- | ---------- |
| Authored  | 2026-08-31 |
| Completed | 2026-08-31 |

## Review Scope

The change set was reviewed uncommitted in the working tree, with HEAD at the
fixed point `4fe4b96`; it has since landed as `fde2a6d`. Reviewed on the two
axes the `code-review` skill covers, run as parallel sub-agents:

- **Standards** — conformance to the repo's documented conventions (British
  spelling, no emoji, TSDoc on exports, strict TS, ESM, kebab-case, the
  `bun run check` gate) plus the Fowler smell baseline.
- **Spec** — fidelity to candidate 1 in
  [review-0002-architecture.html](review-0002-architecture.html) (lines 34-92),
  "Extract the viewer's navigation machine", including the user-approved fuller
  scope that `CityScene` takes a single derived `mode` prop rather than
  re-deriving the precedence internally.

Files under review:

- NEW `viewer/lib/navigation.ts` — the pure state machine: `NavigationState`,
  `NavigationContext`, `NavigationView`, `NavigationMode`, `INITIAL_NAVIGATION`,
  `deriveNavigation` (the single precedence clamp), `closestVisibleAncestor`,
  and the gestures `select`/`explore`/`exploreDistrict`/`back`/`deselect`.
- NEW `viewer/hooks/use-navigation.ts` — the thin React shell: holds the raw
  state, exposes the clamped view and five callbacks, owns the Escape listener.
- NEW `test/unit/viewer/navigation.test.ts` — pure reducer characterisation
  tests (node project).
- NEW `test/unit/viewer/use-navigation.test.tsx` — hook tests (viewer project).
- MOD `viewer/RepoCity.tsx` — deletes the five `useState`s, the three
  re-derivations of the precedence rule, the close/handler functions, the local
  `closestVisibleAncestor`, and the divergent Escape `useEffect`; wires
  `MapViewer` to `useNavigation`; adds a `mode` prop to `CityScene`. −231/+44.

The two axes are reported separately below and deliberately not merged or
re-ranked; a change can pass one axis and fail the other.

## Standards

### Standards hard violations

None found.

- British spelling: clean (`memoise`, `characterise` used).
- No emoji in the change set.
- TSDoc: every export in both new files is documented, including the types.
- No `any`, `@ts-expect-error`, or `biome-ignore` added.
- Knip: every export is consumed — `RepoCity.tsx` imports the hook,
  `closestVisibleAncestor`, and the mode/context types; the pure functions are
  imported by the hook and the tests. No dead exports, no unreferenced file.
- TDD/coverage: `navigation.ts` at 100% lines; `viewer/hooks` at ~97%.
- The extraction cleanly realises the standards' pure-core / imperative-shell
  split (`navigation.ts` pure, `use-navigation.ts` the thin React shell) and
  makes dependencies explicit via `NavigationContext`.

### Standards judgement calls (baseline smells)

1. **Ineffective memo (Speculative Generality / Middle Man).**
   `use-navigation.ts` computed `view = deriveNavigation(state, context)`
   unmemoised, so `view` was a fresh object every render; it was then a
   dependency of the `useMemo` that built the callbacks object, so the memo
   recomputed every render and the returned object was never stable. The
   `useMemo` implied a referential stability it did not deliver. **Resolved in
   the same commit** — see Resolution below.
2. **Repeated O(n) scan (performance smell).** `navigation.ts:childrenOf` does
   `[...context.nodeById.values()].filter(...)` and is called from both
   `deriveNavigation` (every derive) and `explore`. Behaviour-preserving (the
   pre-refactor code used `map.nodes.filter`), but the full-map
   materialise-and-filter runs per render. Judgement call only; left as-is.
3. **Primitive Obsession (pre-existing, carried over).** `selectedId: ""` as the
   "none" sentinel sits beside `null` sentinels for every other id field —
   inconsistent absence-encoding within one type. Inherited from the original
   component, not introduced here; low priority, left as-is.

### Standards test-quality note

Both suites assert real behaviour: the pure suite covers precedence, each
gesture, the drill-down anchor rule, and the two named regressions
(drill-down deselect keeps the anchor; background click on campus clears); the
hook suite covers the five callbacks and Escape==back. Test-file placement in
the node vs viewer project is documented. No standards issue.

## Spec

Verdict: faithful implementation. No missing requirements, no scope creep, no
implemented-but-wrong findings.

### Spec missing or partial requirements

None material. Every named responsibility landed in `navigation.ts`:
`closestVisibleAncestor`, `firstCampusConnection`, `connectionBetween`, the
precedence clamping (`deriveNavigation`), the drill-down anchor rule
(`back`/`deselect` reselect the open anchor), and the Escape policy. All five
inputs exist — `select`, `explore`, `exploreDistrict`, `back`, `deselect` — and
out = `mode` + `selectedId` via `NavigationView`. The spec's "MapViewer,
CityScene, and the overlay builders all read the same derived mode instead of
re-deriving it" is satisfied, including the user-approved `CityScene` `mode`
prop: `focusModel`/`districtModel` gate on `mode !== "focus"`/`"district"`
rather than the old `interiorModel`/`focusModel` chain.

### Spec scope creep

None. The diff is a faithful lift-and-delete: the five `useState`s, the
close/handler functions, the Escape `useEffect`, and the local helper copies are
removed and replaced by `useNavigation`. `connectionBetween` moved from an
in-component function to a module function — within scope.

### Spec implemented-but-wrong

None found. Behaviour is preserved: `select` recomputes
`activeFocus(state, context)` where the old code read the clamped
`activeFocusId` — equivalent; `explore`'s district-clearing in every branch
(including the no-campus early return) matches the old `setDistrictId(null)`
first ordering.

### Spec conformance points confirmed

1. **Precedence in exactly one place.** "interior beats focus beats district" is
   encoded once in the `activeExpanded`/`activeFocus`/`activeDistrict` helpers;
   `deriveNavigation`'s `mode` ternary and every gesture consume those already
   clamped helpers rather than re-deriving. The old triplicate (MapViewer,
   CityScene, overlays) is gone.
2. **Escape and back share one policy.** The hook's Escape listener calls
   `back(current, context)` and `overlayBack = mode === "campus" ? null :
   nav.back` — both dispatch the identical `back` function. The old duplicated
   close logic in the Escape handler is deleted.

### Deliberate behaviour consolidation to note

The old Escape handler read the **raw** ids and omitted `selectNode`'s
connection-fallback, while the back **button** read the **clamped** ids via the
close functions. They diverged only for unreachable stale ids (not reachable in
practice). The refactor unifies both on the clamped close-button path
(`back()`), which is exactly the card's "Escape == back()". This is the single
place behaviour was deliberately consolidated rather than copied verbatim.

## Summary

- **Standards:** 0 hard violations; 3 judgement-call smells. Worst within axis:
  the ineffective `useMemo` in the hook (now resolved).
- **Spec:** 0 missing, 0 scope creep, 0 implemented-but-wrong; both pointed
  questions (single-source precedence, Escape==back) confirmed.

## Resolution (2026-08-31)

Applied in the same commit (`fde2a6d`), behaviour-preserving (`bun run check`
green at 311 tests):

- **Ineffective memo — fixed.** `use-navigation.ts` drops the `useMemo` and
  returns the callbacks object directly, with a comment noting the pre-refactor
  component recreated these handlers each render too. `viewer/hooks` coverage
  rose to ~97%.

Left as-is (judgement calls, not defects): the per-render `childrenOf` scan and
the `""`-vs-`null` sentinel inconsistency, both behaviour-preserving carry-overs
from the original component.
