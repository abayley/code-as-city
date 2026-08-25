---
id: RFC-0002
name: Deduplicate the overview and deployment assembly pipelines
status: Draft
owners:
    - alistairbayley
created: 2026-08-25
updated: 2026-08-25
supersedes: []
superseded_by: null
---

# Deduplicate the overview and deployment assembly pipelines

| Stage     | Timestamp        |
|-----------|------------------|
| Authored  | 2026-08-26 00:35 |
| Started   | 2026-08-26 00:45 |
| Completed |                  |

## Summary

Remove the ~450-460 genuinely duplicated lines (~22% of the combined code)
between `src/lib/assemble-overview.ts` and `src/lib/assemble-deployment.ts`
(plus overlaps with `emit.ts` and `host-config.ts`), behaviour-identically and
golden-verified per commit. The two pipelines keep their deliberately
different shapes (banding vs layering, height formulas); what unifies is the
shared vocabulary: node/edge types, small helpers, the host-config scan, and
the five inference passes both modes document as shared rules.

## Problem statement

The RFC-0001 extraction preserved the historical duplication between the two
modes. A survey found 22 duplicated or near-duplicated clusters, including a
~130-line verbatim re-implementation of `scanHostConfigs` inside the
deployment assembly (the module both modes already import is only consumed by
the overview), field-for-field identical node/edge type declarations, and
five inference passes (OTLP producers, external delivers, database
reads/writes, embedded-database importers, variant backing stores) that
HEURISTICS.md documents as one rule applied in both modes (M1/M8/M10/D13
shared with O8/O11) but that exist as two drifting copies. Every future rule
change currently needs the same edit twice, and the copies have already
drifted (different guards, different id suffixes).

## Context

- Both pipelines are strict TypeScript with typed contexts sharing 15+
  identical fields; the golden-master tests plus live-repo artefact diffs
  give byte-level regression proof for every commit.
- The survey's unifying seam: every shared inference needs only a small "node
  index" record — `(nodeId, files, districtId?, entryFile?)`. The deployment's
  `classificationSets` and the overview's `allModules` are exactly that,
  built differently.
- Some copy divergences look like latent bugs rather than design (the
  overview's delivers pass lacks the deployment's self/empty-file guards; its
  database inference always targets the first database while deployment
  prefers the district-local one; entry classification exists as three
  partial copies of one documented rule; neither delivers copy escapes names
  interpolated into regexes). This refactor preserves them; fixing them is
  follow-up work recorded per-divergence.

## Phase Item Completion Instructions

Update this plan document as you go. When an item is complete, immediately
mark it as complete in the phase checklist.

## Goals

- Byte-identical output at every commit, proven by goldens and live-repo
  artefact diffs (aria-evals both modes, functionary.dev, all emitted files).
- One declaration for the map node/edge/display/metrics/source-ref types.
- One implementation per shared heuristic (M1/O8 OTLP, M10/O8 delivers,
  M8/O8 database flow, D13/O11 embedded databases, D1/D6/O7 variant stores,
  M5/M6 host-config scan), parameterised only where the modes genuinely
  differ (id suffixes, target selection, node universes).
- Shared helper module for the identical small functions (edge dedup add,
  "a->b" key decode, loc sum, room label, basename-minus-extension, id
  collision suffixing, mermaid id sanitising, the footprint formula, the SDK
  and external-reference regex builders).
- Divergences that survive are explicit: either a parameter with both call
  sites visible, or a documented per-mode override.

## Non-Goals

- No behaviour change of any kind, including fixing the latent divergence
  bugs listed in Context (each gets a BACKLOG entry instead).
- No merging of the two pipelines into one: banding (O10) vs layering (M9),
  height formulas (O5 linear vs M11 log), district construction, and module
  granularity stay per-mode by design.
- No viewer or schema changes.

## Proposal

New shared modules, extracted from the existing copies:

- `map-types.ts`: MapNode, MapEdge, NodeDisplay (the overview's superset with
  optional colour/flowOrder), NodeMetrics, SourceRef, FileEdge. Both
  assemblies and emit import them; the per-file re-declarations go.
- `assembly-helpers.ts`: the identical small helpers listed under Goals, each
  taking explicit arguments (no shared state).
- `inference.ts`: the five shared inference passes written once against a
  NodeIndex record type `{ id, files, districtId?, entryFile? }` plus an
  `addEdge` sink and per-mode options (id suffix scheme, target-selection
  strategy, node universe). Deployment builds its NodeIndex from
  `classificationSets`/`fileNodeOwner`; overview from `allModules`.
- Deployment's inline host-config scan is deleted; `hostScan` (already
  computed once in `generate-map.ts`) joins `DeploymentContext`, and the
  duplicated noise-word list lives only in `host-config.ts`.
- The map envelope (schemaVersion/id/name/summary/generatedAt/nodes/edges/
  warnings), the final missing-endpoint edge sweep (M4), and the mermaid id
  sanitiser move into `emit.ts`, parameterised by mode (id suffix, summary
  text, which intermediates to write) so `runOverview` stops re-implementing
  the envelope and write. Overview continues to write exactly the files it
  writes today, no more.
- The overview's local `externalFanIn`/`externalFanOut`/`moduleIsUtility`
  re-derivations are replaced with reads of the C1 `fileCoupling` already in
  its context, provided the values are provably identical (they recompute the
  same edges); if any difference surfaces in goldens, keep the local copy and
  record why.

Where Effect.ts offers a drop-in fit during this work (typed error handling
in emit, Schema for the map envelope), use it per the standing project
preference; anything beyond drop-in stays out of scope.

## Alternatives Considered

- Merge the two pipelines into one parameterised assembly: rejected — the
  modes differ structurally (districts, granularity, layering) and a single
  function would be a thicket of mode flags; sharing the vocabulary and the
  documented-shared rules captures most of the value at far less risk.
- Leave the duplication and rely on HEURISTICS.md discipline: rejected — the
  copies have already drifted, and the drift is invisible without a survey.

## Security Impact

None; same inputs and outputs.

## Reliability Impact

- Golden masters and live artefact diffs gate every commit, as in RFC-0001.
- Risk: "provably identical" claims (coupling re-derivation, snapshot-vs-live
  node checks) that are not. Mitigation: goldens plus full live diffs of all
  emitted artefacts, and reverting to the local copy on any diff.

## Compatibility Impact

None externally; module boundaries change inside src/lib only.

## Testing and Quality Gates

- `bun run check` green at every commit; goldens unchanged throughout (this
  RFC never regenerates them).
- Unit tests accompany the new shared modules: inference passes tested
  through NodeIndex fixtures (both id-suffix schemes), helpers tested
  directly. Prior art: test/unit/*.test.ts.
- Live-repo artefact diff at each phase boundary (aria-evals both modes,
  functionary.dev, every emitted file byte-identical bar generatedAt).

## Rollout Plan

### Phase 1 — types and helpers

- [ ] Extract map-types.ts; both assemblies and emit import it.
- [x] Extract assembly-helpers.ts (identical helpers only); replace all
      copies, including emit's and the three inline loc sums.
- [x] Deployment consumes hostScan from context; delete its inline
      host-config scan and the duplicated noise-word list.

### Phase 2 — shared inference

- [ ] Introduce the NodeIndex record; build it in both assemblies from their
      existing structures.
- [ ] Unify the embedded-database importer pass (closest copies) with unit
      tests, then delivers, then OTLP producers, then database reads/writes,
      then variant backing stores — one commit each, goldens after each.

### Phase 3 — envelope and emit

- [ ] Move the map envelope, M4 edge sweep, and mermaid id sanitiser into
      emit.ts, parameterised by mode; runOverview calls it.
- [ ] Replace the overview's local coupling re-derivations with fileCoupling
      reads, golden-verified (revert and document if outputs differ).

### Phase 4 — close out

- [ ] Full live-repo artefact diff across the test repos, both modes.
- [ ] BACKLOG entries for each preserved divergence bug (delivers guards,
      first-database targeting, entry-classification partial copies,
      unescaped regex interpolation).
- [ ] HEURISTICS.md module pointers updated; mark this RFC completed.

### Rollout Plan Escape Hatch

- If implementation reaches behaviour that this RFC or its design contracts
  do not cover, stop changing the affected scope before inventing a contract.
- Add the smallest missing decision to `## Open Questions`, or to the owning
  RFC if another RFC owns the contract.
- Include evidence, impact, options, and a recommended path.
- Continue the affected implementation only after explicit reviewer or user
  approval.

## Open Questions

- Entry classification (item: three partial copies of M3/O2): unify now
  behind per-mode flags, or leave until the divergence bugs are fixed so the
  unification does not fossilise them? Current plan: leave; revisit when
  fixing the BACKLOG entries.
- Whether the overview should route through emitArtefacts fully (gaining
  coupling.json and deps-*.json) — a behaviour change, so out of scope here;
  worth a user decision later.
