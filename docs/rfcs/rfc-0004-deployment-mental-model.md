---
id: RFC-0004
name: Make the deployment view match the developer's mental model
status: Accepted
owners:
    - alistairbayley
created: 2026-08-26
updated: 2026-08-26
supersedes: []
superseded_by: null
---

# Make the deployment view match the developer's mental model

| Stage     | Timestamp        |
| --------- | ---------------- |
| Authored  | 2026-08-26 16:45 |
| Started   |                  |
| Completed |                  |

## Summary

The deployment view should show the deployed system as its developer pictures
it: the major components, how data moves between them, the processes, data
stores, and external systems — and nothing that merely supports development.
Running the generator over eleven repositories showed a consistent gap between
that goal and the output. The lens recognises only *declaratively hosted*
components (compose services, edge workers) and, wrongly, CI jobs; it has no
category for the way most repositories actually ship — a published executable,
library, or extension — and none for processes an executable starts at
runtime. It also lets development scaffolding, CI maintenance, and duplicated
service definitions crowd the map. This RFC widens and sharpens the model of
"a deployed thing" so the deployment view earns its purpose, while leaving the
module overview's show-everything stance untouched.

## Context

### The two views, restated

- **Deployment view** — the developer's mental map of the running system: the
  major components, the data flow between them, the processes, data stores,
  and external systems. It deliberately simplifies, and it *excludes* things
  that are not part of the deployed system: repo utilities, tooling, CI
  maintenance, dev and test scaffolding.
- **Module overview** — the whole codebase, organised in roughly the same
  shape as the deployment view, for spotting technical problems: oversized or
  complex modules, poor organisation, weak coverage. It hides almost nothing —
  with one standing exception described below.

Both views already share one exclusion, and it stays: **repository tooling
scripts** — the `scripts/` code reachable only from QA-named `package.json`
scripts — are stripped from both, by the existing R1/R2 reachability rules.
That is deliberate and retained unchanged; the module overview is "everything
except the repo's own tooling scripts", not "literally every file". Beyond that
one exception, the two views differ only in what *else* the deployment view
omits. This RFC is about the deployment view's omissions and inclusions; where
it introduces a new exclusion, that exclusion is deployment-view-only unless
stated.

### Evidence

The findings are recorded with evidence in `docs/heuristic-changes.md`
(HC-001, HC-005, HC-007, HC-008, HC-009, HC-010, HC-012). In short, across the
repositories examined:

- **The deployed product is often missing.** mermaid (a library), ollama-code
  (a CLI plus a library plus a VS Code extension), aria (an executable that
  supervises daemons), and every package in aria-tools ship by publication or
  as an executable, not by compose or wrangler. The deployment map found no
  real deployable for any of them.
- **CI jobs fill the vacuum.** With nothing else classed as a deployable, D9
  surfaces routine workflows — "Update Browserslist", "Release", "Gemini PR
  Triage" — as the system's components. Four of ollama-code's seven districts
  are CI jobs.
- **Runtime process shape is invisible.** aria's executable starts background
  daemons through `spawn`/`fork`/`Worker`; none appears, because the topology
  is in code, not a manifest.
- **Scaffolding ranks with the system.** immich gives its e2e harness, plugin
  SDK, and scripts package the same district weight as the server and web app.
- **The shape is fragmented and mistyped where it exists.** supabase's fifteen
  compose files repeat one logical service across host districts — `Db` six
  times — and D5 labels PostgREST and postgres-meta as databases on a
  name substring.

Where a repository genuinely declares a hosted shape (aria-evals, immich,
paperclip, supabase's core), the existing rules capture it well. The gap is
the repositories whose deployment shape is an executable, a published package,
or a runtime process tree — a large fraction of real TypeScript projects.

## Goals

- The deployment view recognises a published artefact (CLI, library, VS Code
  extension) as a first-class deployed component.
- The deployment view recognises runtime-supervised processes (a spawner and
  the daemons it starts) as part of the deployed system.
- The deployment view excludes development scaffolding: CI maintenance, dev and
  test packages, workspace-root aggregators.
- The deployment view shows one node per logical component: services duplicated
  across compose topologies consolidate, and components are typed by a strong
  signal rather than a name substring.
- The module overview keeps its existing scope — the whole codebase minus the
  repository tooling scripts that R1/R2 already strip — and only gains the
  improved component recognition; the new deployment-view exclusions do not
  reach it.
- The existing R1/R2 repository-tooling-script stripping is retained unchanged
  in both views.
- Every change keeps the generator deterministic and lands with a fixture case
  and regenerated goldens.

## Non-Goals

- The legibility and scale cluster (HC-002 dead district colouring, HC-003
  redundant `src/` level, HC-004 barrel-file labels, HC-006 emoji, HC-011
  overview aggregation). Those are a separate concern and a separate RFC.
- New viewer archetype geometry. A published artefact may want its own shape;
  that is tracked in `BACKLOG.md` under archetype shapes and is not blocked by
  this RFC, which can ship with an existing archetype and a distinguishing tag.
- Cross-language deployment inference (a Python ML service, a Go binary). The
  generator stays TypeScript-first; a non-TS service already shows as an
  image-only infra node, which is acceptable.

## Proposal

One principle drives every rule below: **a node belongs in the deployment view
if and only if it is part of the running system as the developer models it.**
The rules sort into three moves — recognise more of what is deployed, exclude
what is not, and get the shape of what remains right.

### Recognise what is deployed

**D14 (new): published-artefact deployables.** A `package.json` that is not
`private` and declares one of the following is a deployed artefact in its own
right:

- `bin` — a CLI. Archetype reflects an executable, not a hosted service.
- a name plus `main`/`module`/`exports` and no `private: true` — a published
  library.
- `engines.vscode` or a `contributes` block — a VS Code extension.

The artefact's entry (the `bin` target, the `exports`/`main` entry, the
extension `main`) is its gateway room; the package's rooms become its
interior, as a hosted service's do today. A repository with several published
packages (aria-tools, mermaid, ollama-code) gets one deployable per package.

This directly fills the HC-001 vacuum, and once it exists, CI jobs no longer
need to stand in for the product.

**D15 (new): runtime-supervised processes.** Within a deployable's own
reachable source, a `spawn`/`fork`/`child_process`/`new Worker(...)` call
whose target resolves to an inventoried entry file marks that target a daemon
the deployable *starts*. Draw the daemon as a process node with a `starts`
edge from the supervisor. Bound the scan to a deployable's reachable source so
it does not fire on tests, examples, or generated code. This captures aria's
executable-plus-daemons shape (HC-012).

Decided: a daemon is drawn **only when the spawn target resolves to an
inventoried entry file** — a literal path, or one clearly derived from one. A
`spawn` on a variable or an external command draws nothing. Silence over a
guess, consistent with the generator's determinism-first stance; this is the
least certain rule and it earns its place by never inventing an edge it cannot
ground in a real file.

### Exclude what is not deployed

**D9 (revised): CI is not a deployable.** A CI workflow is development
infrastructure, not part of the running system, unless it *is* the deployment
mechanism — a job whose run step invokes source that itself deploys (the
aria-evals pattern the rule was built for). Restrict D9's `deployable` output
to that case. Routine workflows (lint, release, dependency bumps, bots) leave
the deployment view; the `calls`/`triggers` edges between genuinely deploying
jobs stay. Nothing about CI changes in the overview (HC-005).

**R5 (new): exclude development-only packages from the deployment view.** A
whole package that the deployed system never reaches — an e2e harness, a plugin
SDK used only by other packages' dev builds, a config package — is development
scaffolding and leaves the *deployment* view, the way R2 already strips
dev-tooling *files* within a package. This is deployment-view-only: the
overview keeps these packages, because seeing them is its job. R5 is distinct
from and does not disturb the existing R1/R2 repository-tooling-script stripping
(the `scripts/` convention), which continues to apply to both views. The
primary test is reachability from a deploy root; a scaffolding-style name
(`e2e`, `*-config`) is a secondary hint. Needs a signal that does not demote a
small but genuinely deployed package (HC-007).

**D2/S1 (revised): drop empty aggregators, name hosts better.** A
workspace-root `package.json` that holds only `workspaces`/`private` and no
source of its own is not a district. D2's fallback host name becomes the
service name, image, or repo name rather than the placeholder "Host host"
(HC-008).

### Get the remaining shape right

**D1 (revised): consolidate a service across compose topologies.** Several
compose files can describe one system in different configurations (dev,
self-host, S3-backed, Minio-backed). Beyond the environment-variant dedup D1
already does, recognise that a service recurring by name across topology files
is one logical component, and fold it to a single node — preferring a canonical
file (`docker-compose.yml`, or `compose.yaml`) over a topology-qualified one.
This removes supabase's six `Db` nodes (HC-009).

**D5 (revised): classify by a strong signal.** A service is a database only on
a known database image (`postgres`, `mysql`, `redis`, `valkey`, ...) or an
exact-store name, not because its name contains a database-adjacent substring.
PostgREST and postgres-meta stop reading as databases (HC-010).

### Archetypes

D14 needs to distinguish a published artefact from a hosted service. The
minimal change reuses an existing archetype (`building` for a library,
`gateway` for a CLI entry) plus a `published`/`cli`/`extension` tag the viewer
can key on, deferring dedicated geometry to the BACKLOG archetype-shapes item.
A later change can promote these to their own archetypes without touching the
classification rule.

### Impact on the module overview

The overview shares the D and M scans for hosts, externals, and flow (O7-O10),
so it inherits the improved component recognition: a published artefact and a
supervised daemon become recognisable there too, and services stop
duplicating. But the overview does **not** take on the *new* exclusions — CI
workflows (D9) and dev and test packages (R5) stay, because seeing them is the
overview's job.

The one existing exclusion the overview already carries is unchanged: the
R1/R2 repository-tooling-script stripping still removes the `scripts/`
convention code from both views. So the rule is: recognition is shared; the
existing tooling-script exclusion is shared; the new deployment-view exclusions
are not.

## Alternatives Considered

- **A whole-repo "no deployment shape" detector that redirects to the
  overview (HC-001 option a).** Rejected, for now. It treats the symptom: a
  library monorepo *does* have a deployment shape — its published packages — so
  the right answer is to show it, not to switch views. And once D14 recognises
  any published or executable package as a deployable, essentially every
  TypeScript repository has a package.json and therefore a deployable, so the
  detector would almost never fire — there is no residual shapeless class left
  to redirect. Dropped rather than deferred.
- **Demote CI jobs to infra rather than excluding them.** Keeps a record of
  the pipeline, but CI is not part of the running system under the pitch, so it
  does not belong in the deployment view at all. It remains in the overview.
- **Infer daemons from any `spawn` in the repo, not just a deployable's
  reachable source.** Simpler to implement, far noisier — test harnesses and
  examples spawn constantly. Bounding to reachable deployable source is the
  price of signal.
- **One big change.** Rejected for the same reason RFC-0001 and RFC-0002 were
  phased: each rule must land with its fixture case and a reviewed golden diff,
  so a determinism regression is caught at the commit that caused it.

## Security Impact

None. The generator reads a repository and emits a static map; it gains no new
inputs or outputs. D15 reads source for `spawn`/`fork` call sites by pattern,
as existing rules already read source for imports and SQL forms.

## Reliability Impact

The core invariant is determinism: the same repository state must produce a
byte-identical `map.json` bar `generatedAt`. Every rule here changes output, so
each lands with regenerated goldens and a live-repo artefact diff, exactly as
the generator bug-fix and divergence-fix slices did. The risk to watch is
iteration order in the new scans (D14 over packages, D15 over call sites): both
must iterate a stable array, never a Map or Set, per the determinism notes in
the review.

## Compatibility Impact

`map.json` stays schema-valid throughout (the vendored validator gates every
golden). New node tags (`published`, `cli`, `starts` edges) are additive; the
viewer ignores tags it does not render, so an un-updated viewer degrades to the
existing shapes. No external API.

## Testing and Quality Gates

- `bun run check` green at every commit.
- The mini-repo fixture grows to exercise each new or changed rule, so the
  golden master pins the intended behaviour. Ordered from simplest to hardest,
  these are the test cases that drive the phases:
    1. A service named `rest`/`meta` over postgres stays non-database (D5).
    2. A workspace-root package with no source produces no district; a
       nameless host gets a real fallback name (D2/S1).
    3. One service defined across two topology compose files collapses to one
       node (D1).
    4. A CI workflow that only lints or releases leaves the deployment view but
       stays in the overview (D9).
    5. A dev-only package (reached from no deploy root) leaves the deployment
       view but stays in the overview (R5).
    6. A `bin` package is a CLI deployable; a published library package is a
       library deployable; a `contributes` package is an extension (D14).
    7. An executable that `spawn`s an inventoried entry draws a `starts` edge to
       a daemon node; a `spawn` on a variable, and a `spawn` in a test file,
       draw nothing (D15).
- The existing R1/R2 repository-tooling-script stripping stays green in both
  views throughout: the current fixture already pins it (the "reachable only
  from QA scripts" golden case), and no phase may regress it.
- Each phase regenerates `test/golden/*` and is diffed against the live repos
  (aria-evals, immich, paperclip, supabase, mermaid, ollama-code, aria) to
  confirm the change moves the intended nodes and only those.

## Rollout Plan

Each phase is independently shippable, lands its fixture case and goldens, and
updates `HEURISTICS.md` and the `docs/heuristic-changes.md` status.

1. **Sharpen the existing shape (safest first).** D5 strong-signal
   classification; D1 cross-topology consolidation; D2/S1 empty-aggregator and
   host-name fixes. These correct and consolidate without adding categories.
2. **Exclude non-deployed scaffolding.** D9 CI restriction; R5 dev-only
   package exclusion. These remove noise; the overview is unaffected.
3. **Add the published-artefact category.** D14. The accepted core of HC-001.
4. **Add runtime process inference.** D15. The most uncertain; ship last so the
   map is already correct without it and it is purely additive.

### Rollout Plan Escape Hatch

- If implementation reaches behaviour this RFC does not cover, stop changing the
  affected scope before inventing a contract.
- Add the smallest missing decision to `## Open Questions`, with evidence,
  impact, options, and a recommendation.
- Continue only after explicit approval.

## Open Questions

- **Library versus internal package.** In a monorepo, which packages are
  *published* (deployed) versus internal build-time dependencies? `private:
  true` and `publishConfig` are the signals; are they reliable enough across
  the sample, or do we need a workspace-dependency analysis? Decide during
  phase 3 against aria-tools and supabase, once we can see how well the
  `private`/`publishConfig` detection performs in practice.

### Decided

- **One deployable per published package.** aria-tools' twenty published CLIs
  are twenty deployables — correct, and wide, but the district-per-package
  structure carries it. No grouping for now; revisit only if a real map proves
  unreadable.
