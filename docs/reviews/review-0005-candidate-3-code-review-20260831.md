---
id: REVIEW-0005
name: Code review of candidate 3 (D17 external-service dedupe + D3 COPY-attribution rule)
status: Complete
owners:
    - alistairbayley
created: 2026-08-31
updated: 2026-08-31
reviews: working tree vs 4dd29cc
---

# Code review of candidate 3 (D17 external-service dedupe + D3 COPY-attribution rule)

| Stage     | Timestamp  |
| --------- | ---------- |
| Authored  | 2026-08-31 |
| Completed | 2026-08-31 |

## Review Scope

The change set is uncommitted in the working tree; HEAD equals the fixed point
`4dd29cc`, so the review diffs the working tree against that commit. Reviewed on
the two axes the `code-review` skill covers, run as parallel sub-agents:

- **Standards** — conformance to the repo's documented conventions (British
  spelling, no emoji, TSDoc on exports, strict TS, ESM with `.ts` import
  extensions, kebab-case, the `bun run check` gate, and HEURISTICS.md's
  shared-rule convention: rules shared between the two map modes are implemented
  once in `inference.ts` with per-mode options) plus the Fowler smell baseline.
- **Spec** — fidelity to candidate 3 in
  [review-0002-architecture-20260830.html](review-0002-architecture-20260830.html)
  (lines 149-205), "Give D17 (and D3) one home, per the catalogue's own
  convention". The user chose the fuller "D3 per the card" scope; the palette
  footnote (line ~202) was explicitly out of scope.

Files under review:

- NEW `src/lib/copy-attribution.ts` — `isExcludedCopyDir(copy, rule)` and the
  `CopyExclusionRule` discriminated union (the two D3 exclusion rules).
- NEW `test/unit/copy-attribution.test.ts` — unit tests for both rule arms.
- MOD `src/lib/inference.ts` — adds `inferExternalServiceUse` (the shared D17
  constructor).
- MOD `src/lib/assemble-deployment-phases.ts` — D17 site calls the shared
  constructor with an `onImporters` node callback; D3 filter calls
  `isExcludedCopyDir`; drops the now-unused `sdkImporterIds` import.
- MOD `src/lib/assemble-overview-phases.ts` — D17 site likewise; drops
  `sdkImporterIds`.
- MOD `src/lib/assemble-overview.ts` — D3 skip calls `isExcludedCopyDir`,
  hoisting `activeRoomDirs`.
- MOD `test/unit/inference.test.ts` — tests for `inferExternalServiceUse`.

Behaviour preservation is guarded end-to-end by the golden test
(`test/generate-map.test.ts`), which compares full `generateMap` output for both
map modes against committed JSON; it passes, and the fixture exercises both D17
("uses" edges in both modes) and D3 (a Dockerfile with room nodes).

The two axes are reported separately below and deliberately not merged or
re-ranked; a change can pass one axis and fail the other.

## Standards

### Standards hard violations

None found. British spelling (`normalised`) is correct; TSDoc is present on every
exported symbol (`inferExternalServiceUse`, `isExcludedCopyDir`,
`CopyExclusionRule`); no `any`/`@ts-expect-error`/`biome-ignore`; kebab-case
filename; `.ts` import extensions. tsc/biome/knip/vitest pass.

### inference.ts — pattern fidelity (the key question)

`inferExternalServiceUse` faithfully follows the established per-mode-options
pattern (`options: { services, entries, edges, fileText, edgeSuffix,
onImporters }`), matching `inferEmbeddedDatabaseUse` exactly. One meaningful and
*correct* divergence: it keeps the original D17 `if (importerIds.length === 0)
continue`, so `onImporters` does not fire for a service with no importers —
whereas `inferEmbeddedDatabaseUse` fires its callback even when empty. This
preserves D17 behaviour (external node drawn only when imported) rather than
blindly copying the sibling; the TSDoc documents it and a test locks it. Faithful
to the HEURISTICS shared-rule convention.

### Standards judgement calls (baseline smells)

1. **Speculative Generality — `copy-attribution.ts` / the `CopyExclusionRule`
   union.** Deletion test: inlined back, the deployment filter is ~3 lines and
   the overview skip is 1 line. The module body is a two-arm discriminated union
   whose arms share *nothing* — no common logic, no shared data, just an
   `if (rule.kind === ...)` dispatching to two independent one-liners. The union
   exists only to let one function serve two callers that never share a code
   path. Contrast `inferExternalServiceUse`, which owns real shared behaviour
   (SDK-import detection, edge construction). HEURISTICS' shared-rule convention
   is about rules genuinely shared between modes; here the two rules are per-mode
   and mutually exclusive. A plain pair of named exported predicates
   (`isUtilityCopyDir`, `isCoarserThanRoom`) would carry the same "visible side
   by side" benefit without the `kind`-switched union. Judgement call, not a
   documented-standard breach.
2. **Feature Envy (structural) — the `utility-room` arm.** Its real logic
   (`roomIdForCopy`, `isUtilityRoom`) still lives in the deployment assembler and
   is passed in as two closures; the module holds only the
   `basename(copy) === "lib"` check and a `Boolean(...)` wrapper. The decision it
   claims to own is mostly still in the caller.

### Standards test-quality note

Both new suites are well-structured: given/when/then names, fast, hand-built
fakes (no `vi.mock`). `copy-attribution.test.ts` covers both arms including
boundary cases (equal dir, nested dir). No standards issue.

## Spec

### D17 — fully faithful

Spec: "Move D17 node+edge construction into `inference.ts` as one function taking
per-mode options (id suffix, parent strategy)." `inferExternalServiceUse` is now
the single edge+loop constructor; both assemblers call it. The edge id is
`` `${importer}--${service.id}${edgeSuffix}` `` with suffix `""` (deployment) /
`"-u"` (overview); node construction is the `onImporters` callback (the "parent
strategy") — deployment parents into its externals district, overview builds an
infra member. Guard, ordering (callback before edges), and payload
(`kind:"data_flow"`, `confidence:0.7`, `label:"uses"`, `sourceRefs`) preserved.

Spec: "byte-identity between modes becomes a property of the code, not of
vigilance." **Satisfied** — the only cross-mode difference is now the `edgeSuffix`
literal, so the payloads cannot silently diverge.

### D3 — Solution met; Problem framing only partially

Spec Solution: "extract a single COPY-attribution function that owns both
exclusion rules explicitly, so the difference between the modes is a named option
rather than two independent re-implementations." `isExcludedCopyDir(copy, rule)`
owns both rules under a discriminated `CopyExclusionRule`; callers pass the rule
as a named option. **This sentence is met**, and both call-sites are provably
behaviour-preserving:

- deployment `!isExcludedCopyDir(...)` de-Morgans exactly to the old
  `basename === "lib"` / `!(roomId && isUtilityRoom)` filter;
- overview: old `activeRooms.some((room) => roomDir(room).startsWith(`${dir}/`))`
  equals new `activeRoomDirs.some((dir) => dir.startsWith(`${copy}/`))` with
  `activeRoomDirs = activeRooms.map(roomDir)` hoisted.

### Spec missing or partial requirements

- **The card's Problem/heading are broader than the delivered scope.** Spec
  Problem: "D3 is spread over five modules"; heading: "Give D17 (and D3) one
  home". Only the two exclusion rules were unified; the divergent room-building
  (deployment) vs dir→host attribution (overview) machinery — the rest of the
  five modules — was left in place. Planning established that parsing/
  normalisation is already centralised in `dockerfile.ts` and that the
  surrounding machinery is genuinely divergent, so this is a defensible reading
  of the *Solution* text, but it does not "give D3 one home" the way the heading
  and Problem imply. Flagged for the user's judgement — not a defect, but a
  narrower scope than the "full D3" the user selected.

### Spec scope creep

None. The out-of-scope palette footnote (line ~202) was correctly left
untouched.

### Spec implemented-but-wrong

None found; both extractions are provably equivalent to the originals, confirmed
by the golden test for both map modes.

## Summary

- **Standards:** 0 hard violations; 2 judgement-call smells, both on
  `copy-attribution.ts`. Worst within axis: the `CopyExclusionRule` union reads
  as Speculative Generality (two mutually-exclusive per-mode rules under one
  `kind` switch that share no code path).
- **Spec:** D17 fully faithful; D3's Solution sentence met and behaviour-
  preserving; 0 scope creep, 0 implemented-but-wrong. Worst within axis: the D3
  scope is narrower than the card's "one home" framing — a design decision to
  confirm, not a defect.

Both axes converge on the same open question about D3's `copy-attribution.ts`:
whether the `kind`-switched union earns its place, or whether two plain named
predicates (`isUtilityCopyDir`, `isCoarserThanRoom`) would give the same
"both rules visible in one place" benefit more honestly. Left for the user to
decide.

## Resolution (2026-08-31)

The user chose to go further on D3 rather than split the union or stop. Applied
in the same working tree, behaviour-preserving (golden test green for both map
modes; `bun run check` green at 326 tests):

- **Normalisation given one home, extended to the third consumer.** Added
  `normaliseCopyDir` to `copy-attribution.ts` and routed all three consumers of
  a service's copies through it: the deployment host districts
  (`assemble-deployment-phases.ts`), the overview dir→host map
  (`assemble-overview.ts`), and — the site the Standards axis flagged as the
  third home — reachability's host-deploy roots (`reachability.ts`). The
  trailing-slash normalisation that was duplicated verbatim in three modules now
  has a single definition, paired with `isExcludedCopyDir`'s
  "already-normalised" precondition. This strengthens the module's right to
  exist (deletion test: inlining now re-scatters both the exclusion rules and
  the normalisation across three files).
- **The `CopyExclusionRule` union kept.** The two-predicate split was declined
  in favour of going further; the uniform `isExcludedCopyDir(copy, rule)` call
  shape is retained. The Standards judgement call stands but is softened: the
  module now owns real shared behaviour (normalisation) beyond the union.

### Investigated and deliberately not done: the full machinery merge

The card's Problem framing ("D3 spread over five modules … give D3 one home")
implies unifying the attribution machinery itself. Mapping every consumer showed
this is not a clean seam:

- **Deployment** normalises → "names a dir" → "no source under it" →
  utility-exclusion, and needs the *pre-exclusion* tier separately for
  `claimedSegments`; survivors drive room nodes, `fileNodeOwner`, flow layout,
  and edges.
- **Overview** normalises → coarser-exclusion (dockerfile services only) → a
  dir→host map.
- **Reachability** normalises only, raw, no exclusion (by design).

The only operation all three share is normalisation (now unified). A single
function spanning the room-building and dir→host machinery would need ~5
optional knobs and two return tiers — a grab-bag interface that degrades the
design and risks behaviour on the generator's most complex function, guarded
only by the golden test. Stopped there on the evidence; the divergent machinery
stays mode-local.
