---
id: RFC-0001
name: Extract the generator into typed modules per heuristic group
status: Draft
owners:
    - alistairbayley
created: 2026-08-25
updated: 2026-08-25
supersedes: []
superseded_by: null
---

# Extract the generator into typed modules per heuristic group

| Stage     | Timestamp        |
|-----------|------------------|
| Authored  | 2026-08-25 20:49 |
| Started   | 2026-08-25 21:20 |
| Completed |                  |

## Summary

Split `src/generate-map.mjs` (~2500 lines of untyped ESM, grown by accretion)
into strict TypeScript modules, one per HEURISTICS.md rule group, with the
existing golden-master tests proving byte-identical output at every commit.
The CLI becomes a thin TypeScript entry point run with bun. Behaviour does not
change; the outcome is a codebase where each documented heuristic group has a
matching module, each module can gain unit tests, and future rule changes are
localised.

## Problem statement

The generator is a single file with no types and no seams. Every rule group
(inventory, structure, deployment shape, coupling, reachability, map shaping,
overview) lives in one namespace of shared mutable bindings; the overview mode
is a giant early-exiting block that duplicates deployment-mode logic (for
example, external "delivers" inference exists twice in near-identical form).
Changes require reading the whole file to know what a binding feeds, and only
golden-master tests — no unit tests — stand between an edit and a silent
regression.

## Context

- HEURISTICS.md already partitions every rule into stable groups
  (I/S/D/C/R/M/O) with IDs. The code sections roughly follow the same order,
  so the module boundaries are pre-agreed vocabulary, not new design.
- The golden-master harness (test/generate-map.test.ts over
  test/fixtures/mini-repo) pins determinism: same input, byte-identical
  map.json except `generatedAt`. It currently exercises only part of the
  generator (compose, Dockerfile binding, CI workflows, imports, QA-script
  stripping); it does not exercise wrangler, crontab schedules, the coverage
  scan, the TSDoc scan, migrations collapse, embedded-database detection,
  coupling elimination, or multi-compose variant dedupe.
- Strict tooling (biome, knip, maximally strict tsconfig, vitest) is in place
  and `bun run check` is green.

## Phase Item Completion Instructions

Update this plan document as you go. When an item is complete, immediately
mark it as complete in the phase checklist.

## Goals

- Byte-identical generator output at every commit, proven by the golden
  masters (and live-repo diffs at phase boundaries).
- One strict TypeScript module per heuristic group, named after it, each with
  an explicit interface (inputs in, results out — no shared mutable module
  state between groups).
- `src/generate-map.mjs` replaced by a TypeScript CLI entry point that is
  safe to import, with the `import.meta.main` guard covered per the CLI
  testing standard.
- Unit tests for each extracted module's pure logic as it is extracted
  (parser functions, classification predicates, metric formulas).

## Non-Goals

- No behaviour change of any kind, including bug fixes discovered on the way
  (record them in BACKLOG.md instead).
- No deduplication of the overview/deployment pipelines — that is a follow-up
  refactor once both are typed and visible.
- No viewer changes, no schema changes, no changes to vendor/functionary.
- No agent-assisted enrichment (the generator stays deterministic).

## Proposal

### Module boundaries (by heuristic group)

One module per group, mirroring HEURISTICS.md:

- inventory (I): file listing via git/fs walk, ignore rules, test detection.
- packages (S1): package discovery and segmentation.
- rooms (S2): room construction from files.
- imports (S3): import scan, resolution, file/package edges.
- coupling (C): fan-in/fan-out/instability metrics and elimination sets.
- deployment-shape (D): compose parsing, Dockerfile binding, crontab
  schedules, wrangler, CI workflows, image classes, host dedupe.
- reachability (R): deploy/script/operational roots, QA classification,
  dev-tooling stripping, QA residue.
- scans: coverage, TSDoc prose, embedded-database detection (shared by both
  modes).
- assemble-deployment (M): the deployment-map assembly pipeline.
- assemble-overview (O): the overview assembly pipeline.
- emit: map.json plus intermediate artefacts (deploy-shape, deps, dot,
  mermaid).
- types: the map output types and shared intermediate types.
- cli: argument parsing and orchestration; the only imperative shell.

Each module exports named functions taking explicit arguments and returning
values; the CLI threads results between them.

Where a library opportunity arises during extraction, Effect.ts is the chosen
library for anything it is good for — schema validation, typed error handling,
concurrency, database access — not zod. Adopting it must not change output;
anything beyond a drop-in use belongs in a follow-up.

Extraction order follows data flow (inventory first, assembly last) so each
commit moves one group and re-points the shim.

### Mechanics per commit

1. Create the new `.ts` module with the group's functions, typed strictly.
2. In the remaining `.mjs`/entry file, delete the moved code and import the
   module instead.
3. Run `bun run check` (goldens included); commit only when green.

The entry point remains `src/generate-map.mjs` (importing TS via bun) until
the final commits swap it for `src/generate-map.ts`. README run commands
switch from `node` to `bun` at that point.

## Alternatives Considered

- Decompose by pipeline stage (the file's numbered sections): rejected —
  nearly the same cut, but heuristic groups match the documentation users
  actually read.
- Functional core / imperative shell as the primary cut: rejected as the
  first move — coarser modules hide the group seams; the chosen cut still
  ends with a thin imperative shell (cli + emit) around pure modules.
- Extract as `.mjs` first, type later: rejected — two passes over every line
  for smaller per-commit diffs that the golden master makes unnecessary.
- Dedupe overview/deployment logic during extraction: rejected — riskier
  commits; deferred to a follow-up RFC.

## Security Impact

None. The generator reads local repositories and writes local files; no new
inputs, outputs, or dependencies beyond dev tooling.

## Reliability Impact

- The golden master is the regression gate; its coverage is extended in
  Phase 0 before any extraction.
- Failure mode: a heuristic exercised by no fixture regresses silently.
  Mitigation: Phase 0 fixture enrichment plus live-repo output diffs
  (aria-evals, aria-tools, nzlaw, functionary.dev — both modes) at each phase
  boundary, acknowledging that live-repo churn can cause benign diffs.

## Compatibility Impact

- CLI runtime changes from node to bun at the end (README updated).
- map.json output is byte-identical throughout; the viewer and validator are
  unaffected.

## Testing and Quality Gates

- `bun run check` green at every commit.
- Golden masters unchanged at every commit (except Phase 0, which extends
  them deliberately and regenerates via the README procedure).
- New unit tests accompany each extracted module, testing external behaviour
  through the module's public functions (fixtures as inputs, values out) —
  not implementation details. Prior art: test/generate-map.test.ts for the
  spawn-and-compare style; unit tests should instead import the module and
  run in milliseconds.
- Live-repo diff at each phase boundary: regenerate out/ maps for the test
  repos before and after, diff ignoring `generatedAt`.

## Rollout Plan

Tiny commits; each leaves `bun run check` green and goldens byte-identical.

### Phase 0 — strengthen the safety net (goldens change here, deliberately)

- [x] Extend mini-repo (or add a sibling fixture) with a wrangler worker
      config and entry file.
- [x] Add a crontab referencing a compose service (schedule tags).
- [x] Add a coverage artefact so the coverage scan produces metrics.
- [x] Add file-level TSDoc blocks that surface as node descriptions.
- [x] Add a migrations directory (collapse rule O3).
- [x] Add an embedded-database dependency (D13/O11).
- [x] Add enough utility modules to trigger coupling elimination (C2) and a
      second compose variant to trigger host dedupe (D-group).
- [x] Verify each addition changes the goldens in the expected way (nodes,
      tags, warnings) before regenerating them; document any heuristic that
      turns out impractical to fixture and fall back to live-repo diffs for
      it.

### Phase 1 — types and shell

- [ ] Add the map/output types module (from the validator's vocabulary and
      the emitted shapes).
- [x] Extract argument parsing and small pure utilities (kebab, titleCase,
      readJson/readText wrappers) into typed modules with unit tests.

### Phase 2 — front of the pipeline

- [x] Extract inventory (I) with unit tests for ignore/test-path rules.
- [x] Extract packages (S1).
- [x] Extract rooms (S2).
- [x] Extract imports (S3) with unit tests for resolveImport.
- [x] Extract coupling metrics (C1) with unit tests for the formulas.

### Phase 3 — deployment shape and scans

- [x] Extract compose parsing with unit tests (indentation cases, depends_on
      forms, the 2-space-only limitation pinned by a test).
- [x] Extract Dockerfile parsing and service binding.
- [x] Extract crontab, wrangler, and CI workflow scans.
- [x] Extract host construction and variant dedupe.
- [x] Extract the coverage, TSDoc, and embedded-database scans.

### Phase 4 — reachability

- [x] Extract roots and reachability sets (R1) with unit tests for the QA
      script-name classification.
- [x] Extract dev-tooling stripping and QA residue (R2).
- [x] Extract cross-package path reassignment (R4).

### Phase 5 — assembly and emit

- [x] Extract flow layering and shared assembly helpers.
- [x] Extract the overview assembly (O) as a function returning the map.
- [x] Extract the deployment assembly (M) as a function returning the map.
- [x] Extract emit (map.json and intermediates).
- [x] Replace src/generate-map.mjs with src/generate-map.ts (importable, with
      the guarded `import.meta.main` handoff and a subprocess integration
      test); update README and test harness to run it with bun.

### Phase 6 — close out

- [x] Full live-repo diff across the test repos, both modes.
- [ ] Update HEURISTICS.md rule-to-module pointers and BACKLOG.md.
- [ ] Mark this RFC completed.

### Rollout Plan Escape Hatch

- If implementation reaches behaviour that this RFC or its design contracts
  do not cover, stop changing the affected scope before inventing a contract.
- Add the smallest missing decision to `## Open Questions`, or to the owning
  RFC if another RFC owns the contract.
- Include evidence, impact, options, and a recommended path.
- Continue the affected implementation only after explicit reviewer or user
  approval.

## Open Questions

- Whether coupling elimination (C2) and multi-compose dedupe can be fixtured
  small enough to be worth it, or should rely on live-repo diffs (resolved in
  Phase 0 by attempting it).
- Where prose-enrichment (the agreed-but-unbuilt agent post-pass) plugs in
  once modules exist — out of scope here, but the emit interface should not
  preclude it.
