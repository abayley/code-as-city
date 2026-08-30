---
id: REVIEW-0003
name: Code review of candidate 2 (flow-layout tests + shared sizing)
status: Complete
owners:
    - alistairbayley
created: 2026-08-30
updated: 2026-08-30
reviews: working tree vs 48b3dce
---

# Code review of candidate 2 (flow-layout tests + shared sizing)

| Stage     | Timestamp  |
| --------- | ---------- |
| Authored  | 2026-08-30 |
| Completed | 2026-08-30 |

## Review Scope

The change set is uncommitted in the working tree; HEAD equals the fixed point
`48b3dce`, so the review diffs the working tree against that commit. Reviewed on
the two axes the `code-review` skill covers, run as parallel sub-agents:

- **Standards** — conformance to the repo's documented conventions (British
  spelling, no emoji, TSDoc on exports, strict TS, ESM, kebab-case, the
  `bun run check` gate) plus the Fowler smell baseline.
- **Spec** — fidelity to candidate 2 in
  [review-0002-architecture.html](review-0002-architecture.html) (lines 94-147),
  "Put the flow layout under test; share the sizing constants".

Files under review:

- NEW `viewer/lib/sizing.ts` — `DEFAULT_FOOTPRINT`, `MARKER_FOOTPRINT_SCALE`
  (0.8), `PlaqueVariant`, `plaqueMetrics(variant, labelLength)`.
- NEW `test/unit/viewer/flow-layout.test.ts` — characterisation tests.
- NEW `test/unit/viewer/sizing.test.ts` — unit tests for the sizing module.
- MOD `viewer/lib/flow-layout.ts` — imports the sizing module; replaces the
  footprint literal, the plaque formula, and the router `renderScale`.
- MOD `viewer/RepoCity.tsx` — replaces four footprint literals, the MapMarker
  plaque formula, and the footprint `* 0.8`; rewrites two stale comments.

The two axes are reported separately below and deliberately not merged or
re-ranked; a change can pass one axis and fail the other.

## Standards

### Standards hard violations

None found.

- British spelling: clean (`rasterise`/`rasterises` used; no `color` identifiers
  introduced in `sizing.ts` — the `color` field on districts is
  pre-existing/Three.js API).
- No emoji in the change set. The glyphs at `RepoCity.tsx:969-970` are
  pre-existing nameplate UI, not in the diff.
- TSDoc: every export in `sizing.ts` is documented — `DEFAULT_FOOTPRINT`,
  `MARKER_FOOTPRINT_SCALE`, `PlaqueVariant`, `plaqueMetrics`. The private
  `clamp` needs none but has one.
- No `any`, `@ts-expect-error`, or `biome-ignore` added.
- Knip: all four exports are imported by both `RepoCity.tsx` and
  `flow-layout.ts` (and the test) — no dead exports, no unreferenced file.
- TDD/coverage: both new modules are covered by real characterisation tests.

### Standards judgement calls (baseline smells)

1. **Repeated Switch — extraction is incomplete.** `plaqueMetrics` pulled the
   width/height per-variant switch into `sizing.ts`, but the sibling per-variant
   values stay as a raw cascade in `RepoCity.tsx:942-943`:

   ```ts
   const codeFontSize = (interior ? 0.13 : landmark ? 0.2 : quieter ? 0.145 : 0.17) * labelScale;
   const labelFontSize = (interior ? 0.17 : landmark ? 0.29 : quieter ? 0.205 : 0.24) * labelScale;
   ```

   `PlaqueVariant` now exists as a first-class concept, yet these two
   variant-keyed values were left behind, so adding or retuning a variant
   touches both `plaqueMetrics` and this cascade. Folding the font sizes into
   `plaqueMetrics` (or a shared variant table) would finish the job.
   `plaqueColor` (`RepoCity.tsx:944-949`) keys off `node.kind`, a different
   axis — correctly left alone.

2. **Duplicated Code (partial) — the boolean-to-variant ternary appears twice.**
   `RepoCity.tsx:932-938` (`interior`/`landmark`/`quieter`/`standard`) and
   `flow-layout.ts:494` (`hasInterior` -> `landmark` / `external` -> `quieter` /
   `standard`). They genuinely differ (the layout path is campus-only and has no
   `interior` arm), so this is defensible rather than a clear extract-shared
   case, but the mapping logic now lives in two places and could drift.

### Standards test-quality note

Both suites assert real behaviour, not trivialities: determinism via deep-equal,
in-bounds placement, front-to-back layering, district grouping/ordering,
satellite/system fallbacks, edge-router caching/null paths/cell-cap;
`sizing.test.ts` exercises the linear formula away from clamps plus both clamp
extremes. The excluded-branches note (`flow-layout.test.ts:239-248`) is honest
about coverage gaps. No standards issue.

## Spec

Verdict: faithful implementation. Render-identical intent verified numerically;
one deliberate deviation from the spec's literal wording to surface.

### Spec missing or partial requirements

- **150k-expansion escape hatch: not tested.** Spec (a): "the 600k-cell and
  150k-expansion escape hatches". Only the 600k-cell cap is covered
  (`flow-layout.test.ts:218`). The 150k branch is documented as skipped
  (`flow-layout.test.ts:239-248`) as needing a heavy fixture. Honest gap, not
  concealed — but it is a spec item left uncovered.
- **Throw paths: not tested.** Spec (a): "the throw paths". Documented
  (`flow-layout.test.ts:239-248`) as unreachable through the two public
  functions, since `layers`/`positions` are populated for every input node. The
  reasoning is plausible; an honest judgement rather than a silent omission.
- **`createEdgeRouter` characterised: yes** (route waypoints, per-id caching,
  null on missing endpoints, cell-cap). `computeFlowLayout`: determinism,
  band ordering, bounds/layering, districts, satellite/system fallbacks all
  covered.
- **Test admission: no config change; runs via the existing node glob.** Spec
  (a) said admit `test/unit/viewer/*.test.ts` "(or a lib glob)".
  `vitest.config.ts` is unchanged; `test/unit/viewer/flow-layout.test.ts`
  already matches the generator project's `test/**/*.test.ts`. Confirmed
  running in the node project. Consistent with the spec's intent (the file
  runs), though it satisfies neither literal option the spec offered.

### Spec scope creep

- Minor, in-scope comment rewrites at the two former duplication sites
  (`RepoCity.tsx:918-922`, `flow-layout.ts:620-624`). These directly address the
  drift the spec named. No refactors beyond the three constants.

### Spec implemented-but-wrong

- **None found.** All four plaque variants reproduce the original clamped
  formulas exactly (`sizing.ts:57-63` vs the diff `-` lines). Variant mappings
  match both old ternaries (RepoCity interior/landmark/quieter/standard;
  flow-layout landmark/quieter/standard). `MARKER_FOOTPRINT_SCALE` (0.8)
  replaces the two literal `0.8`s only (`RepoCity.tsx:921`,
  `flow-layout.ts:625`). The 0.68 mesh `structureScale` (`RepoCity.tsx:623`) is
  untouched.

### Spec conformance question to surface (for the user to decide)

Spec benefit: "the 0.8-vs-0.68 class of drift becomes impossible — **one
constant**, two readers." The implementation deliberately keeps **two**
constants: `MARKER_FOOTPRINT_SCALE = 0.8` (`sizing.ts:28`) plus the local `0.68`
in RepoCity, with a header comment "Do not collapse these into one value"
(`sizing.ts:6-13`). Note also that the 0.68 render scale was **not** moved into
`sizing.ts` — only the shared 0.8 was. This satisfies the spec's intent (kill
the drift by making both values explicit and documented) but contradicts its
literal "one constant" framing. Flagged with evidence, not resolved: decide
whether the two scales are intended to stay distinct (current implementation) or
whether the 0.68 retune was meant to propagate to the marker and router — in
which case 0.8 is a leftover bug and any change is a render change needing
sign-off.

## Summary

- **Standards:** 0 hard violations; 2 judgement-call smells. Worst within axis:
  the incomplete Repeated Switch extraction (font-size cascade left behind in
  `RepoCity.tsx:942-943`).
- **Spec:** 0 implemented-but-wrong; 2 partial coverage items (150k cap and
  throw paths, both honestly documented as skipped) and 1 open conformance
  question. Worst within axis: the "one constant" vs "two deliberately distinct
  constants" tension, which is a design decision awaiting the user, not a defect.

## Resolution (2026-08-30)

Applied in the same working tree, render-identical (every number preserved;
`bun run check` green at 269 tests):

- **Repeated Switch — fixed.** The per-variant width/height/font-size numbers now
  live in one `PLAQUE_BANDS` table in `sizing.ts`; `plaqueMetrics` returns
  `codeFontSize`/`labelFontSize` alongside the dimensions, and `RepoCity` reads
  them from `plaque.*` instead of its own cascade. A variant is now retuned in
  exactly one place.
- **Duplicated variant ternary — fixed.** Extracted `plaqueVariantFor(...)` into
  `sizing.ts`; both `RepoCity` (with the `interior` case) and `flow-layout`
  (which passes `interior: false`) call it, so the mapping has one home.
- **Magic `0.68`/`0.85` — named.** The Structure mesh scales are now
  `STRUCTURE_MESH_SCALE` (0.68) and `STRUCTURE_MESH_SCALE_INTERIOR` (0.85) in
  `sizing.ts`, each with TSDoc explaining why they sit below the marker scale.
  The `sizing.ts` header and the `RepoCity` structure comment now state why the
  mesh and marker scales differ on purpose.

Still open (unchanged by this pass): the two partial-coverage items and the
design question of whether the mesh (0.68) and marker (0.8) scales should ever
be unified — that remains a deliberate visual-check decision for the user.
