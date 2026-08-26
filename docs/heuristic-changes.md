---
id: HEURISTIC-CHANGES
name: Candidate heuristic changes
status: Open
owners:
    - alistairbayley
created: 2026-08-26
updated: 2026-08-26
---

# Candidate Heuristic Changes

A running catalogue of heuristic changes the generator may want, gathered by
running it over real repositories and comparing the output against a
developer's mental model of each system. Each entry cites evidence and names
the rule(s) it touches; none is committed until it has an RFC or a direct
change with regenerated goldens.

This is not `HEURISTICS.md`. That file is the catalogue of rules the generator
*applies today*; this file is the backlog of rules we think should *change*,
with the evidence for why.

The "deployed model" cluster — HC-001, HC-005, HC-007, HC-008, HC-009,
HC-010, HC-012 — is drawn together into `docs/rfcs/rfc-0004-deployment-mental-model.md`.
The legibility and scale cluster — HC-002, HC-003, HC-004, HC-006, HC-011 —
is not yet in an RFC.

## Status Key

- **Proposed** — evidenced, direction sketched, not yet decided.
- **Accepted** — decided; awaiting implementation.
- **Done** — implemented; moved to a one-line note with the commit.
- **Rejected** — considered and declined, with the reason kept.

## Candidate Index

| ID     | Title                                                       | Rules       | Status   |
| ------ | ----------------------------------------------------------- | ----------- | -------- |
| HC-001 | No deployment category for a published package              | new; D, M   | Accepted |
| HC-002 | O4 shared-district colouring never fires                    | O4          | Proposed |
| HC-003 | Collapse a redundant sole `src/` level                      | S2, M3      | Proposed |
| HC-004 | Disambiguate colliding module labels across packages        | O2, M3, S4  | Proposed |
| HC-005 | CI maintenance workflows surface as deployables             | D9, D10, M3 | Accepted |
| HC-006 | Emoji leak from workflow names into node labels             | D9          | Proposed |
| HC-007 | Dev and test packages rank as peer districts                | S1, M3, R   | Accepted |
| HC-008 | Monorepo root and generic hosts make empty districts        | S1, D2, M3  | Accepted |
| HC-009 | Same service across compose files duplicates infra          | D1          | Accepted |
| HC-010 | D5 name classification mislabels API layers as databases    | D5          | Accepted |
| HC-011 | Overview emits one node per file; unrenderable at scale     | O2; viewer  | Proposed |
| HC-012 | Runtime-spawned daemons are invisible to the deployment map | new; D, M   | Accepted |

## HC-001: No Deployment Category for a Published Package

**Rules:** a new detection or classification rule ahead of the D and M groups.

**Evidence.** The deployment lens recognises hosts (compose), edge workers
(wrangler), and CI jobs — but not *publication to a registry*, which is how a
large class of repos actually ships: an npm library, a CLI, a VS Code
extension. mermaid is a diagramming library; ollama-code is a CLI plus a core
library plus a VS Code extension. Neither is deployed via compose or wrangler,
so neither has a real deployable, and the deployment map has nothing of the
actual product to show. aria-tools is the same in the multi-package form:
about twenty published CLIs render as 42 identical `worker` boxes, 0
`deployable`. aria-evals, the repo the generator was designed for, produces 16
gateways and 9 deployables from the same rules, because it genuinely declares
a deployment shape.

The vacuum is then filled by HC-005: with no real deployable, the only
`deployable` nodes the generator finds are CI workflow jobs.

**Decision (accepted).** Add a first-class "published package" deployment
category, so a library, CLI, or VS Code extension is a recognised deployable
target in its own right rather than a bare district or a vacuum for CI jobs to
fill. Signals to draw on, in `package.json`: `bin` (a CLI), a non-private
package with `main`/`module`/`exports` and a name (a published library),
`publishConfig`, an `engines.vscode` or a `contributes` block (a VS Code
extension). The archetype should distinguish these from a hosted service. One
deployable per published package. Drawn together with its sibling changes into
the accepted `docs/rfcs/rfc-0004-deployment-mental-model.md`, which also
rejected the whole-repo low-signal redirect: once any published package is a
deployable, essentially every repo has one, so there is no shapeless case to
redirect.

## HC-002: O4 Shared-District Colouring Never Fires

**Rules:** O4 (overview shared-code district colouring).

**Evidence.** Zero districts are coloured as shared code across every repo
examined — 118 districts in total (aria-tools, nzlaw, aria-evals, paperclip
41, aria 4, supabase 31). O4 colours a district purple when at least 60% of
its modules are utility (fan-in >= 2, instability <= 0.33). At file
granularity a district almost never reaches that cut, so the feature is a
no-op. The `HEURISTICS.md` failure note already suspects the threshold is
untuned; the evidence is that it never triggers at all, at any scale.

**Direction (to decide).** Either lower the cut, or move the measure back to
directory granularity (its original intent), or drop the feature. Needs a pass
over more repos to see what threshold would separate shared-code districts
from function-area ones without false positives.

## HC-003: Collapse a Redundant Sole `src/` Level

**Rules:** S2 (dominant-segment expansion), M3 (district assembly).

**Evidence.** In aria-tools every package renders as `@Aria/Code Auditor`
(district) -> `Src` (building) -> `Cli` (module). The `Src` level conveys
nothing — it is the universal source directory — and it recurs in every one of
the twenty packages. When a package's content sits entirely under `src/`, that
level should collapse into the district rather than appear as an intermediate
building.

**Direction (to decide).** When `src/` is a package's sole dominant segment,
promote its expanded rooms directly into the district and drop the `Src`
wrapper. Check this does not regress packages where `src/` sits alongside
other top-level code that legitimately needs the grouping.

## HC-004: Disambiguate Colliding Module Labels Across Packages

**Rules:** O2 (overview module labelling), M3 (deployment room labelling), S4.

**Evidence.** aria-tools' overview has 17 modules labelled "Logger", 17
"Config", 17 "Cli" — one per package. At scale it is far worse and has one
dominant cause: `index.ts` barrel files. paperclip has **94 modules labelled
"Index"**, supabase 79, aria 14. Every directory's barrel entry becomes a
node labelled "Index", conveying nothing. Other collisions ("Types", "Utils",
"Helpers", "Execute") are the same phenomenon on other conventional filenames.
The ids and source refs disambiguate; the visible label does not. Viewer
grouping softens the within-district case, but 94 "Index" nodes across a map
defeat it.

**Direction (to decide).** Two parts. (a) The high-value fix: label a barrel
file (`index.ts`, `index.tsx`, `mod.ts`) by the directory it indexes, not
"Index" — this alone removes the 94-way collision. (b) For remaining
cross-package collisions, package-qualify the label or extend O2's
within-district disambiguation across districts. Part (a) is clearly worth
doing; part (b) is a judgement call given viewer grouping.

## HC-005: CI Maintenance Workflows Surface as Deployables

**Rules:** D9 (CI job districts), D10 (workflow calls edges), M3.

**Evidence.** D9 turns any workflow with a cron schedule, a `workflow_run`
trigger, or a run step invoking repo source into a job district with a
`deployable` building. On aria-evals this is correct: the workflows invoke
real span-ingest and scorer code that deploys. On a library or CLI it
misfires: mermaid's deployables are "Update Browserslist", "Refresh Screenshot
Sheet Order", "Scorecard Supply Chain Security", "E2E"; ollama-code's are
"Release", "Gemini Scheduled PR Triage", "Gemini Scheduled Issue Triage",
"Generate Weekly Community Report". Four of ollama-code's seven districts are
`CI: <workflow>`, and they are the *only* deployables — routine repo
maintenance and bots presented as the system's deployed components.

**Direction (to decide).** Demote CI jobs from `deployable`, or gate D9 to
workflows that invoke source that actually deploys (not lint, release, or bot
maintenance), or group all CI into one clearly-labelled concern rather than
peer districts. Interacts with HC-001: once a published package is a real
deployable, CI jobs no longer need to fill the vacuum.

## HC-006: Emoji Leak From Workflow Names Into Node Labels

**Rules:** D9 (job naming).

**Evidence.** ollama-code has four node labels carrying emoji pulled straight
from workflow names: "Generate Weekly Community Report" and "Gemini Scheduled
PR Triage" each keep a trailing emoji. Map output should be plain text.

**Direction (to decide).** Strip emoji (and other non-label punctuation) when
deriving a node label from an external name. Small, self-contained; mostly
moot if HC-005 removes CI jobs from the map anyway.

## HC-007: Dev and Test Packages Rank as Peer Districts

**Rules:** S1 (package to district), M3, the R reachability group.

**Evidence.** immich's deployment map gives equal district billing to the
deployed system and to its scaffolding: alongside "Prod host", "Immich"
(server) and "Immich Web" sit "@Immich/E2e Auth Server", "@Immich/Plugin
Core", "@Immich/Plugin Sdk", "@Immich/Scripts". The e2e harness, the plugin
SDK, and the scripts package are development and test aids, not parts of the
running system, yet they are districts of the same weight as the server. R2
strips dev tooling at file granularity within a package but does not demote a
whole package that exists only to support development.

**Direction (to decide).** Rank or fold dev, test, and tooling packages —
detected by name (`e2e`, `scripts`, `*-config`), by being depended on only by
other packages' dev scripts, or by never being reachable from a deploy root —
so the deployed system reads first. Needs a signal that does not also demote a
legitimately small deployed package.

## HC-008: Monorepo Root and Generic Hosts Make Empty Districts

**Rules:** S1 (package to district), D2 (host naming), M3.

**Evidence.** excalidraw's map carries a district "Excalidraw Monorepo" from
the workspace-root `package.json`, which is a build aggregator, not a real
package with its own code. Its compose host is labelled "Host host" — D2 found
no informative path segment and fell back to a placeholder doubled with its
kind. Both are empty or near-empty districts that add width without meaning.

**Direction (to decide).** Skip a district for a workspace-root package that
holds no source of its own (only `workspaces`/`private`), and give D2 a better
fallback than "Host host" — the compose service name, the image, or the repo
name. Small, isolated cleanups; group with HC-006 as the "mechanical label"
family.

## HC-009: Same Service Across Compose Files Duplicates Infra

**Rules:** D1 (one host district per compose file, environment-variant dedup).

**Evidence.** supabase ships about fifteen compose files for different
deployment topologies — dev, self-host, S3-backed storage, Minio-backed
storage, logging, pgbouncer. D1 makes one host district per file and dedups
only *environment variants* (a host covered >=50% by a higher-ranked one).
These files are not variants of one topology, so nothing merges: the map has
eight host districts and the same logical service repeated across them — `Db`
six times, `Storage`, `Rest`, `Minio`, `Imgproxy` three times each, `Studio`
and `Api Gw` twice. The developer's model is one platform with one postgres;
the map shows six. This is the multi-compose analogue of the environment-
variant case D1 already handles.

**Direction (to decide).** Recognise that several compose files can describe
the same system in different configurations, and consolidate a service that
recurs by name across them into one node (or pick a canonical compose — a
`docker-compose.yml` over `docker-compose.<topology>.yml`). Distinct from
overlays, which D1 already skips. Needs a rule for which file is canonical and
how to fold the rest.

## HC-010: D5 Name Classification Mislabels API Layers as Databases

**Rules:** D5 (infra classification from image or service name).

**Evidence.** In supabase, `Rest` (PostgREST, an HTTP API over postgres) and
`Meta` (postgres-meta, a management API) are both classified as `database`.
D5's name table matches a database-adjacent token in the service name and
mislabels an API layer as the store it fronts. A reader would take the map to
show three databases where there is one.

**Direction (to decide).** Tighten D5 so a service is a database only on a
stronger signal than a substring — a known database image (`postgres`,
`mysql`, `redis`, `valkey`), or a name that is exactly a store, not one that
merely contains `pg`/`postgres` as a qualifier. Small, self-contained.

## HC-011: Overview Emits One Node per File, Unrenderable at Scale

**Rules:** O2 (every file is a module); the viewer's renderer.

**Evidence.** The overview draws one 3D structure per source file. On the
large repos that is 2189 nodes (paperclip), 5426 (supabase), 5598 (aria) — the
supabase and aria overviews are what crush the browser. A map at that
granularity is also hard to read even when it renders: no human holds five
thousand modules in view. The deployment map avoids this by collapsing to
deployment shape; the overview has no equivalent aggregation.

**Direction (to decide).** Give the overview a level-of-detail: aggregate a
directory to a single drill-in-able node above some size, the way the
deployment map already promotes rooms into buildings, and expand only on
demand. Could live in the generator (emit aggregated nodes with the detail
behind an interior) or the viewer (cull and expand by camera distance).
Probably needs both, and its own RFC — it is the largest of the legibility
items and the one that gates using the tool on real large repos at all.

## HC-012: Runtime-Spawned Daemons Are Invisible to the Deployment Map

**Rules:** a new inference rule in the D and M groups.

**Evidence.** aria deploys an executable — `bin.aria` points at
`agent/src/index.ts` — that starts background daemons and workers at runtime
(`spawn`, `fork`, `Worker` calls through the agent code). That is a real
deployment shape: one process that supervises others. The generator reads only
*declared* deployment config (compose, Dockerfile, wrangler, crontab, CI), so
none of it appears; the deployment map showed 2 CI jobs and no product. The
correction to the earlier note: aria has a clear deployment model; the
generator captured none of it, both because the executable is not a recognised
deployable (HC-001) and because the daemons it starts are configured in code,
not in a manifest.

**Direction (to decide).** Infer a runtime process topology from `spawn` /
`fork` / `Worker` / `child_process` calls in a deployable's own source: the
spawner is a supervisor, the spawned entry files are daemons it runs, drawn as
processes with a `starts` edge. Bounded to a deployable's reachable source so
it does not fire on test or example code. Larger and less certain than the
manifest-based rules; a signal worth capturing but needs care to avoid noise.

## Repositories Examined

| Repo            | Shape                                  | Modes run      | Deployment map verdict                                         |
| --------------- | -------------------------------------- | -------------- | -------------------------------------------------------------- |
| aria-evals      | Deployment-shaped, multi-host          | deployment, ov | Good: the design target                                        |
| aria-tools      | Tooling monorepo, ~20 CLIs             | deployment, ov | Degenerate: 42 workers, 0 deployables (HC-001)                 |
| nzlaw           | Small, two packages                    | deployment, ov | Reasonable                                                     |
| functionary.dev | Cloudflare edge app                    | deployment, ov | Good but sparse (edges by mode design)                         |
| immich          | Self-hosted server, 10 compose files   | deployment, ov | Core shape captured; scaffolding over-ranked (HC-007)          |
| mermaid         | Diagramming library, plugins           | deployment     | Wrong: CI jobs as deployables (HC-001, HC-005)                 |
| ollama-code     | CLI, core lib, VS Code extension       | deployment     | Wrong: no real deployable, CI jobs fill it (HC-001, HC-005)    |
| excalidraw      | Self-host app plus published library   | deployment     | App captured; the library invisible (HC-001, HC-008)           |
| paperclip       | Design tool: server, db, 44 packages   | deployment     | Real shape captured; CI jobs and scale clutter (HC-005)        |
| supabase        | Postgres platform, ~15 compose files   | deployment     | Full stack found but services duplicated 2-6x (HC-009, HC-010) |
| aria            | Agent executable, spawned daemons, SDK | deployment     | Missed its whole shape: executable + daemons (HC-001, HC-012)  |
