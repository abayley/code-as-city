---
id: HEURISTIC-CHANGES
name: Candidate heuristic changes
status: Open
owners:
    - alistairbayley
created: 2026-08-26
updated: 2026-09-21
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
The legibility and scale cluster — only HC-011 remains open (HC-003, HC-004,
HC-006 done; HC-002 rejected as based on incorrect evidence) — is being worked
directly, without an RFC. HC-017 to HC-027 come from a 2026-09 comparison run
over six repositories (excalidraw, immich, mermaid, paperclip, ollama-code,
supabase) against independently authored architecture diagrams of each,
produced with the archify skill from the same repo evidence. Archify is not a
gold standard — it is agent-authored, one diagram per repo — but its per-repo
diagrams make a useful contrast: a semantic reading of the same manifests.

## Status Key

- **Proposed** — evidenced, direction sketched, not yet decided.
- **Accepted** — decided; awaiting implementation.
- **Done** — implemented; moved to a one-line note with the commit.
- **Rejected** — considered and declined, with the reason kept.

## Candidate Index

| ID     | Title                                                                                                   | Rules           | Status   |
| ------ | ------------------------------------------------------------------------------------------------------- | --------------- | -------- |
| HC-001 | No deployment category for a published package                                                          | new; D, M       | Done     |
| HC-002 | O4 shared-district colouring never fires                                                                | O4              | Rejected |
| HC-003 | Collapse a redundant sole `src/` level                                                                  | S2, M3          | Done     |
| HC-004 | Disambiguate colliding module labels across packages                                                    | O2, M3, S4      | Done     |
| HC-005 | CI maintenance workflows surface as deployables                                                         | D9, D10, M3     | Done     |
| HC-006 | Emoji leak from workflow names into node labels                                                         | D9              | Done     |
| HC-007 | Dev and test packages rank as peer districts                                                            | S1, M3, R       | Done     |
| HC-008 | Monorepo root and generic hosts make empty districts                                                    | S1, D2, M3      | Done     |
| HC-009 | Same service across compose files duplicates infra                                                      | D1              | Done     |
| HC-010 | D5 name classification mislabels API layers as databases                                                | D5              | Done     |
| HC-011 | Overview emits one node per file; unrenderable at scale                                                 | O2; viewer      | Proposed |
| HC-012 | Runtime-spawned daemons are invisible to the deployment map                                             | new; D, M       | Done     |
| HC-013 | No deployment category for an app you run directly                                                      | new; D16, R5    | Done     |
| HC-014 | External systems (IMAP, LLM APIs) from client SDKs go unseen                                            | new; D17        | Done     |
| HC-015 | Same-named packages merge silently at the room level                                                    | S, rooms        | Done     |
| HC-016 | Overview gold means both shared-district and .tsx module                                                | O4; viewer      | Done     |
| HC-017 | Compose `build.context` with a default Dockerfile never binds                                           | D3              | Done     |
| HC-018 | A standalone root Dockerfile declares no deployment                                                     | D1, D3          | Proposed |
| HC-019 | Client-SDK table misses common SDKs and cannot resolve endpoints                                        | D13, D17, M6    | Done     |
| HC-020 | D1 folds distinct services that merely share a name                                                     | D1              | Done     |
| HC-021 | Every non-private workspace library becomes a published deployable                                      | D14             | Proposed |
| HC-022 | Next.js apps are not runnable; `docs` dirs are not apps                                                 | D16, I3         | Proposed |
| HC-023 | In-host service calls and monitoring scrapes draw no edges                                              | new; D, M       | Proposed |
| HC-024 | Inferred edges over-fire; templates and dev environments present as production                          | M8, M10, D7, D3 | Proposed |
| HC-025 | Platform deploy configs (Netlify, Vercel, ECS, quadlet) go unseen                                       | new; D          | Proposed |
| HC-026 | Non-Node services (Python) are never inventoried                                                        | I1, D17         | Proposed |
| HC-027 | D14 entry resolution misses conventional entries                                                        | D14             | Done     |
| HC-028 | Residual packages fragment and orphan their root files; districts label by directory, not artefact role | M3, S4          | Done     |

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

**Resolution (Done).** D14 classifies a non-private package.json declaring
`bin` (CLI), `engines.vscode`/`contributes` (VS Code extension), or a
`main`/`module`/`exports` entry with a name (published library) as a published
artefact, one deployable per package. The `private: true` flag alone proved a
reliable published-vs-internal signal across the sample (aria-tools' private
root aggregator and mermaid's private `example-diagram`/`local-editor` are
excluded; the public tool and library packages are not), so `publishConfig` and
workspace-dependency analysis were not needed — the phase-3 open question is
resolved in favour of the simple signal. The artefact's source entry is resolved
(dist->src, `.m/cjs`->`.ts`, then `src/index.ts`/`index.ts`/`src/main.ts`) and
seeded as a deploy root so a bundled library is not swept as an R3 orphan; the
owning node becomes the deployable, a CLI/extension as a `gateway`, a library as
a `building` (a `gateway` when it has fewer than two rooms, which the validator
requires), tagged `cli`/`published`/`extension`. R5 never strips a published
artefact. Verified: aria-tools now yields 17 CLI deployables (was 0),
ollama-code a CLI plus a library, mermaid two published libraries; aria-evals is
unchanged and every sampled repo stays schema-valid and deterministic. The
overview already archetypes a published entry as a gateway via O2, so it remains
recognisable there without a separate pass. Fixture: `packages/greeter` (CLI),
`packages/toolkit` (library), `packages/ext` (extension); a `generate-map`
assertion pins the three tags.

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

**Rejected — the premise is wrong.** O4 *does* fire. aria-evals (the repo its
thresholds were tuned on) colours its `Lib` district gold — `src/lib` is >=60%
utility modules, so O4 marks it as shared code, correctly. The "zero across
every repo" evidence above was measured on a set that missed this (or counted
only multi-package districts); it is inaccurate. O4 fires selectively — on a
district that is genuinely concentrated shared/utility code — and abstains
elsewhere (supabase's "Shared Data" at 0.18, aria's SDK at 0.21 are not utility
by the fan-in/instability measure), which is the intended behaviour, not a
no-op. No change is wanted. The real issue in this area is a colour *collision*,
tracked separately as HC-016.

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

**Resolution (Done, label part).** `roomLabel` now drops a leading `src`
segment, so `src/core` reads as "Core" and `src/utils` as "Utils" rather than
"Src / Core" / "Src / Utils" — the redundant `src/` prefix that recurred on
every expanded room across every package is gone (verified: 0 "Src / ..."
labels in aria-tools, paperclip, supabase, aria-evals; all still valid). Ids and
matching keep the full segment; only the label changes. Fixture: packages/api's
`src/routes`/`src/jobs`/`src/migrations` read as Routes/Jobs/Migrations; a
`generate-map` assertion pins the absence of any "Src / " prefix.

*Deferred residual.* The bare `Src` *building* (a package's loose `src`-root
files) still sits between the district and its entry rooms — and it is now the
D14 deployable node. Fully collapsing it (promoting those files to the district
and moving the deployable marking to the entry room, e.g. "Cli") would improve
the shape further, but it needs the dominant-segment signal threaded into
assembly and a decision on where the deployable node lands, so it is left as a
follow-up rather than folded in here.

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

**Resolution (Done).** Part (a) is implemented via a `barrelAwareName` helper:
an `index`/`mod` file is labelled by the directory it indexes rather than
"Index" (`src/cli/index.ts` -> "Cli", `src/server/index.ts` -> "Server"). It is
applied in the OVERVIEW only, where modules are flat and the 94-way collision
bites; the deployment view keeps "Index" because a barrel there sits *under* its
directory-named building (`Cli -> index.ts`), so labelling it by the directory
would just duplicate the parent. Ids and matching keep `fileModuleName`, so only
the visible label changes. Verified: paperclip's overview "Index" count went 94
-> 0 (now Src 36, Ui 16, Server 13, Cli 13, ...), supabase 79 -> 0, aria 14 -> 0;
all overviews stay schema-valid. Fixture: `packages/toolkit/src/index.ts` now
reads as "Src"; a `generate-map` assertion pins that no overview node is labelled
"Index". Part (b) (cross-package qualification) is left to viewer grouping for
now, as the note anticipated. Note the residual: a sole-`src` barrel still reads
as "Src" — that is HC-003's redundant-`src`-level concern, not this one.

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

**Resolution (Done).** D9 is gated to workflows that are the deployment
mechanism: a workflow enters the deployment view only when at least one of its
run-step invocations resolves to deploy-reachable source. Routine maintenance —
lint, release, dependency bumps, bots — invokes tooling, tests, or nothing, so
it leaves the deployment view; the `calls`/`triggers` edges among the deploying
jobs that remain are unchanged. CI never appears in the overview, so the change
is deployment-view-only. Verified: mermaid's four CI deployables and
ollama-code's four both drop to zero, while a fixture `deploy.yml` that runs the
api service's entry (a deploy root) stays and the fixture `ci.yml` that runs a
test leaves. Until D14 lands, a library/CLI repo's deployment view can be sparse
— that vacuum is HC-001's to fill, not CI's. Fixture: `deploy.yml` alongside
`ci.yml`; a `generate-map` assertion pins that only the deploying workflow is a
deployable.

## HC-006: Emoji Leak From Workflow Names Into Node Labels

**Rules:** D9 (job naming).

**Evidence.** ollama-code has four node labels carrying emoji pulled straight
from workflow names: "Generate Weekly Community Report" and "Gemini Scheduled
PR Triage" each keep a trailing emoji. Map output should be plain text.

**Direction (to decide).** Strip emoji (and other non-label punctuation) when
deriving a node label from an external name. Small, self-contained; mostly
moot if HC-005 removes CI jobs from the map anyway.

**Resolution (Done).** As predicted, D9 (HC-005) removed the offending CI jobs,
so no sampled repo still shows an emoji label. To cover the residual case — a
*deploying* CI workflow, which D9 keeps, whose name carries an emoji — the label
helper `titleCase` now strips Extended_Pictographic characters, variation
selectors, and ZWJ joiners and tidies the whitespace they leave. Because
`titleCase` builds every label (ids use `kebab`), this cleans any label from an
uncontrolled name, not just workflows. No golden changed (a no-op for clean
labels); a `text.ts` unit test pins "Release 🚀" -> "Release".

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

**Resolution (Done).** R5 (new, deployment-view-only) excludes a package that
no *host* deploy root reaches. The host roots are the compose service COPYs and
entries, the wrangler worker entry, and web-app entry dirs — deliberately not
package `bin`/`main`, since those are what D14 will turn into deployables, not a
signal that the hosts deploy the package. The primary test is pure reachability;
a residual (compose-claimed) or path-referenced package is spared, and R5 only
fires when the repo has a resolved host deployment shape, so a library monorepo
stays intact until D14. The scaffolding-name hint was not needed — reachability
alone protects genuinely-deployed packages and avoids demoting a small one.
Verified on the fixture: a `@mini/e2e` package reachable only from its own `e2e`
script leaves the deployment view and stays in the overview. Fixture:
`packages/e2e`; a `generate-map` assertion pins the split.

**immich (the evidence repo): D3 `./` fix folded in (per the RFC Open
Question's decision).** immich's Dockerfiles use `./`-prefixed COPY paths
(`COPY ./server ./server/`) that D3 previously dropped, so immich had no host
deploy shape for R5 to read. D3 now normalises the `./` prefix, and — separately
— a COPY that names a file with no source under it (immich's layer-cache
`COPY ./server/package.json`) no longer claims the package, which had been
flipping it to the residual path and exploding it into per-directory districts.
With both in place R5 fires on immich: `@immich/e2e-auth-server` and
`@immich/scripts` leave the deployment view, while `plugin-sdk`/`plugin-core`
stay — they are baked into the server image, so for immich they are genuinely
deployed and HC-007's "used only by dev builds" premise does not hold.

*Scale consequence (HC-011, not this rule).* Reading immich's COPYs correctly
also makes its whole server package host-reachable, so it is no longer hidden as
R3 orphans and is shown in full: immich's deployment map grows from 86 to ~355
nodes, dominated by the server package's ~342 files. That is the legibility-and-
scale concern RFC-0004 explicitly defers to HC-011 (deployment/overview
aggregation of a large deployed package), not something R5 or D3 should solve
here. aria-evals stays at 53 nodes and supabase keeps its core services, so the
change is contained to repos whose Dockerfiles COPY whole large packages.

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

**Resolution (Done).**

- *D2 host name.* A root or all-generic compose path yields no informative
  segment, so the fallback host name is now the repo basename, not the
  placeholder "host". Verified on live excalidraw: "Host host" became
  "Excalidraw host". Fixture: a repo-root `docker-compose.yml`; `hosts.ts`
  unit cases.
- *S1 empty aggregator.* Already satisfied by the existing assembly: districts
  are keyed off packages that own active rooms, so a source-less workspace-root
  package produces no district in either view. The mini-repo fixture's root
  (only `name`/`private`/`workspaces` plus a QA script) exercises this and the
  goldens pin the absence — no production change was required.
- *Out of scope (observed).* excalidraw's "Excalidraw Monorepo" district is
  **not** empty: its root holds `scripts/build-*.js` build tooling (nine
  files). These survive because R1 classes "build" as operational, not QA, so
  R2 does not strip them. That is a build-script-stripping/R5 concern, distinct
  from S1's empty-aggregator contract, and is left for the R5 phase rather than
  folded into S1 here.

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

**Resolution (Done).** After the existing environment-variant dedup, D1 now
folds a service name recurring across the surviving compose files of a
directory to a single owner node. The owner is chosen by a total order —
canonical unqualified file (`docker-compose.yml`, `compose.yaml`) first, then
highest env rank, then lowest filename — so the pick is independent of
iteration order. Every other occurrence of the name is shadowed: the direct
definition in another topology file and the D6-carried backing node alike are
suppressed, and a host left with no node of its own (a `pg15`-only db override)
is dropped. The rule is directory-scoped, so a separate deployment's compose
(immich's `e2e/`) stays independent, and it applies in both map modes so the
overview stops duplicating too. Verified on live supabase: the six `Db` nodes
became one under the canonical `docker/docker-compose.yml`; immich keeps its
single `Prod host` and one `Db`. Fixture: a `docker-compose.s3.yml` topology
file beside the canonical one; `hosts.ts` unit cases for the owner order.

## HC-010: D5 Name Classification Mislabels API Layers as Databases

**Rules:** D5 (infra classification from image or service name).

**Evidence.** In supabase, `Rest` (PostgREST, an HTTP API over postgres) and
`Meta` (postgres-meta, a management API) are both classified as `database`.
D5's name table matches a database-adjacent token in the service name and
mislabels an API layer as the store it fronts. A reader would take the map to
show three databases where there is one.

**Resolution (Done).** The mislabel was the image substring, not the service
name: `rest`'s image is `postgrest/postgrest` and `meta`'s is
`supabase/postgres-meta`, both of which contain `postgres`. D5 now classes a
service as a database only when the image's base name — the final path segment
with tag and registry/org stripped — is exactly a known store name
(`postgres`, `postgresql`, `mysql`, `mariadb`, `clickhouse`,
`clickhouse-server`, `mongo`, ...), or when the service name is store-like.
`postgrest` and `postgres-meta` fail the exact match and stay non-databases;
`supabase/postgres` still resolves to `postgres`. Verified on live supabase:
`Rest` and `Meta` became `worker`, only `Db` remains a database (its six-way
duplication is HC-009's D1 consolidation, separate). Fixture: `rest`/`meta`
services in `docker-compose.yml`, plus a `hosts.ts` unit case.

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

**Resolution (Done).** D15 (`daemons.ts`) scans deploy-reachable, non-test
source for a `spawn`/`spawnSync`/`fork`/`execFile[Sync]`/`Bun.spawn`/`new Worker`
call whose first path argument is a *literal* — bare, or inside a
`new URL('<path>', import.meta.url)` — that resolves to an inventoried entry
(dist->src and `.m/cjs`->`.ts` conventions applied). The target becomes a
`deployable`/`worker` process node tagged `daemon`, with an edge from the
supervisor's node labelled "starts".

Two decisions worth recording:

- *Edge kind.* The RFC named a `starts` edge, but the output schema's edge-kind
  enum is `depends_on`/`calls`/`data_flow`/`deploys` only — there is no `starts`
  kind. The edge is emitted as `calls` (the supervisor invokes the daemon) with
  the label "starts", evidence `inferred`, confidence 0.7. A safe, local
  reinterpretation that keeps every golden schema-valid.
- *Coverage.* Held to the RFC's explicit rule — "a spawn on a variable draws
  nothing" — D15 fires on none of the eleven sampled repos, aria included: aria
  spawns its `worker-main.ts` through a variable
  (`Bun.spawn([execPath, entrypoint])`), and the rest spawn variables or
  external binaries (`launchctl`, `systemctl`). This is the intended silence
  over a guess, not a defect; D15 fires when a repo spawns a direct literal,
  which the fixture exercises. Broadening to trace a literal through an
  intervening variable would catch aria's daemon but is exactly the variable
  case the RFC chose to exclude, so it was not done. Fixture:
  `packages/greeter` spawns `./worker.ts` (a daemon), plus a variable spawn and
  a spawn in `cli.test.ts` that both draw nothing; a `generate-map` assertion
  pins all three outcomes.

## HC-013: No Deployment Category for an App You Run Directly

**Rules:** a new detection rule (D16); interacts with R5.

**Evidence.** RFC-0004 gave the deployment view a category for every *declared*
deployable — a compose host, a wrangler edge, a published package (D14). It
still had none for an app you simply *run*, of which two turned up immediately.
aria-mail (`emailoauth`) is a single Bun process: `src/server/server.ts` calls
`startBackgroundServices` (the IMAP/email sync) and then `Bun.serve`, all
in-process; `src/runtime/api/email-api.ts` is not a second entry point but an
internal `EmailAPI` module. The generator showed one bare "Emailoauth" district,
no deployable, no externals. excalidraw is a Vite SPA whose entry is
`excalidraw-app/App.tsx`/`index.tsx` at the *package root*, not under
`app`/`pages`/`src/app`; because that entry was in no recognised web-entry dir,
R5 (new in RFC-0004) wrongly excluded the whole web app as dev-only — the actual
product vanished from its own deployment map.

**Resolution (Done).** D16 recognises a runnable app: a web-role package with a
root SPA entry, or a package whose `start`/`serve` script targets source that
starts a server (`Bun.serve`/`.listen`/`createServer`/fastify/express). Its
entry becomes a `gateway` deployable tagged `app` or `server`, and seeds a
deploy root so R3 does not orphan it. Critically, a runnable entry is NOT a host
deploy root: independent runnable apps are separate deployments, so making one a
host root would (and briefly did) make the repo look host-shaped and let R5
strip everything the app does not import — aria's whole agent was dropped by a
trivial `apps/fonts` sub-app until this was corrected. Instead R5 spares runnable
packages directly, as it spares published artefacts. D16 also takes precedence
over D14 (a runnable app that declares `main` shows as the app, not a library).
Verified: aria-mail gains a `server` gateway from `src/server`, excalidraw's web
app returns (excalidraw-app no longer R5-excluded), and aria is unchanged at
~100 nodes; aria-evals stays 53 and every sampled repo is deterministic and
schema-valid. Fixture: `packages/service` (a `start`-script server) and a
web-role `@mini/web`; a `generate-map` assertion pins both tags.

## HC-014: External Systems From Client SDKs Go Unseen

**Rules:** a new external-detection rule alongside the M6/M10/D11/D12 family.

**Evidence.** The generator detects an external system only from an OTLP
exporter endpoint (M6), an env-prefixed SDK reference (M10 `delivers`), an S3
or R2 command (D11), or an https URL in a package-root `config.yaml` (D12). It
has no rule for the most common way an app names an external: a *client SDK
dependency*. aria-mail is a Bun server that talks to an IMAP mail server (via an
`imapflow`/`node-imap`-style client) and to an LLM API (an `openai`/
`@anthropic-ai/sdk`-style client), both central to its purpose; the deployment
map shows neither, so the app reads as a lone server with no outside world. The
same blind spot hides an SMTP relay, a Stripe/Twilio API, a Redis/Postgres
client that is not declared in compose, and so on.

**Direction (to decide).** Recognise an external system from a known
client-SDK dependency in `package.json` — mail (`imapflow`, `nodemailer`), LLM
providers (`openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `ollama`),
and other well-known service clients — drawing one external cloud node per
distinct service with an inferred `delivers`/`data_flow` edge from the module
that imports it (as M10 already does for env-prefixed SDKs). Needs a curated,
vendor-biased table like D5's, and a decision on whether a bare dependency (not
yet imported by deployed code) should draw a node.

**Resolution (Done).** D17 (`scans.ts`, mirroring D13/O11) matches a curated,
vendor-biased table of service client SDKs — IMAP/SMTP mail
(`imapflow`/`node-imap`/`nodemailer`), LLM providers (`openai`,
`@anthropic-ai/sdk`, `@google/generative-ai`, `ollama`, `cohere-ai`, Mistral,
Groq), and a few common APIs (Stripe, Twilio). One external cloud node per
distinct service, several SDKs folding to one, in BOTH map modes, with an
inferred `data_flow` "uses" edge from every module whose source imports the SDK.
On the bare-dependency question: the node is drawn only when a deployed module
actually imports the SDK, so an unused dependency conjures nothing. The table is
deliberately precise — offline siblings (`@anthropic-ai/tokenizer`, `mailparser`)
are libraries, not clients, and are excluded. Verified across the sample:
aria-mail gains "Anthropic API" and "IMAP mail server" (completing the shape its
D16 server started); aria surfaces three LLM providers, immich an SMTP server,
supabase/ollama-code/aria-tools their LLM APIs; aria-evals/mermaid/paperclip/
excalidraw gain nothing (no such SDKs). Fixture: `packages/api` imports `openai`
(`src/ai.ts`); unit tests pin the scan (including the offline-library exclusion)
and a `generate-map` assertion pins the external node and its `uses` edge.

## HC-015: Same-Named Packages Merge Silently at the Room Level

**Rules:** the S/structure group (`rooms.ts`), room id construction.

**Evidence.** A room's id is `${pkg.id}-${kebab(segment)}`, and `pkg.id` is the
kebab-cased package name. When two packages in different directories share a
name — a repo's root and a workspace package both named `@scope/pkg`, as in
ollama-code (root and `packages/core` are both `@tcsenpai/ollama-code`) — their
same-segment rooms collide on that id, and `buildRooms`' map keeps the first and
pushes the second package's files into it. The second package's code is then
silently attributed to the first package's district. This surfaced while
reproducing the overview district-id clash (now fixed): two `@mini/toolkit`
packages each with a `src/` segment merged into one district's modules; they
avoided the merge in the committed fixture only because their segments differ.
The district-id clash was the visible symptom; this room-level merge is the
quieter cousin, and it mis-attributes source in both map modes whenever the
segments do coincide.

**Direction (to decide).** Key room ids by the package *directory* (unique)
rather than the package *name*, or uniquify colliding room ids the way the
overview now uniquifies district ids. A directory-based key is the cleaner fix
but touches every id downstream, so it needs regenerated goldens and a check
that nothing keys off the current `pkg.id`-based room id.

**Resolution (Done).** Fixed at the source: `discoverPackages` now makes each
`pkg.id` unique, suffixing a later collision (`x-tool`, then `x-tool-2`) in the
stable package-discovery order. Because room ids, district ids (both views), and
everything else derive from `pkg.id`, one fix removes the room merge and any
district clash at once — no separate room/district uniquify pass, and the
directory-based rekey (which would churn every id) is avoided. Only same-named
packages are affected. Verified: ollama-code's root and `packages/core` now take
distinct ids (`tcsenpai-ollama-code`, `-2`); a fixture with two `@mini/toolkit`
packages sharing a `src/` segment keeps their files in separate districts (a
`generate-map` assertion pins that they do not share a parent), where before the
second package's files were absorbed into the first's room. The overview's
district-id uniquify pass stays as a cheap guard against kebab flattening two
distinct ids together, which this fix does not cover.

## HC-016: Overview Gold Means Both Shared-District and .tsx Module

**Rules:** O4 (shared-district colour), the overview module-colour rule, viewer.

**Evidence.** The overview uses one gold, `#C79F40`, for two unrelated things.
O4 colours a whole *district* gold when it is >=60% shared/utility modules
(aria-evals' `Lib`). Separately, a *module* whose files are all `.tsx` is
coloured gold too — and `OVERVIEW_TSX_COLOR` is defined as the identical hex to
`OVERVIEW_SHARED_COLOR`. So on aria-evals' overview, 26 gold nodes are shared-lib
`.ts` files (inheriting the gold `Lib` district) and 11 more are `.tsx` React
components in the *terracotta* `Dashboard` district, gold for the unrelated
"this is UI" reason. A reader cannot tell a shared-code node from a UI node, and
neither meaning is in the legend, which documents only edges. This is what makes
a gold node in an otherwise-terracotta district unexplainable at a glance.

**Direction (to decide).** Give the `.tsx`/UI signal its own distinct colour (a
fourth swatch) so gold means shared code only, or drop the `.tsx` colouring
entirely and let UI modules inherit their district colour. Either way, add the
overview's node/district colours to the legend, which currently explains only
the edge swatches. Viewer-side and small; the choice is whether "this is UI" is
a signal worth its own colour.

**Resolution (Done).** The `.tsx`/UI signal is kept but given its own darker
terracotta `#A15A34`, distinct from the app terracotta `#C77740` and the shared
gold `#C79F40` it used to collide with. Gold now means shared code only —
verified on aria-evals: of the formerly-gold nodes, the 26 shared-lib `.ts`
files stay gold and the 11 `src/dashboard/client/*.tsx` components move to the
new colour (0 `.tsx` left gold). The legend gained a structures section that
lists each overview structure colour — function area, shared code, UI component,
infrastructure — keyed off the colours actually present in the loaded map, so it
shows in the overview (which sets node colours) and not the deployment map
(which leaves colour to the archetype). Verified in the browser. The overview
golden updated (the fixture's `@mini/web` `app.tsx` now `#A15A34`).

## HC-017: Compose `build.context` With a Default Dockerfile Never Binds

**Rules:** D3 (service-to-Dockerfile binding).

**Evidence.** D3 binds a compose service to its Dockerfile only via
`build.dockerfile` or the `images/<service>.Dockerfile` convention. When a
service declares only `build.context` — so the Dockerfile is the default
`<context>/Dockerfile` — the binding fails and the service keeps no COPYs and
no entry. Three repos, three symptoms:

- excalidraw: `docker-compose.yml` builds `context: .` with no `dockerfile`
  key; the root `Dockerfile` COPYs `.` and multi-stage-copies
  `excalidraw-app/build` into nginx. deploy-shape.json shows
  `copies: [], entryFile: null`, so the host's only service is a bare
  image-only infra node and R5 has no host deploy shape to read.
- immich: the `immich-machine-learning` service builds
  `context: ../machine-learning`, `dockerfile: Dockerfile` — a
  *compose-relative* path the parser does not resolve (it reads as
  repo-root `Dockerfile`, which does not exist, or is dropped). The whole
  Python ML service is therefore unbuilt on the map, while CI resolves the
  same path fine (`.github/workflows/docker.yml` builds
  `machine-learning/Dockerfile`).
- paperclip: the `server` service's Dockerfile is resolved, but the binding
  only attributed the per-package `package.json` COPYs from the deps stage,
  so the host building has no rooms and `entryFile` is null despite
  `ENTRYPOINT docker-entrypoint.sh` resolving to an inventoried script.

**Direction (to decide).** Resolve the default: a `build` block with a
context but no `dockerfile` names `<context>/Dockerfile`; a relative
`dockerfile` resolves against the context, not the repo root. Verify the
paperclip deps-stage case separately — binding succeeds there, but
coarse/COPY-from stages attribute nothing (a known D3 stance for the
overview; the deployment view may want the first-party stage instead).

**Resolution (Done).** Three changes, all in the D3 home (`compose.ts`
capturing `build.context`, `hosts.ts` resolving, `dockerfile.ts` consuming):

- *Default Dockerfile.* A build block naming only a local context binds
  `<composeDir>/<context>/Dockerfile` when it exists (excalidraw's service is
  now bound to its root `Dockerfile`; its COPYs are `COPY . .`, so rooms stay
  empty — the coarse-COPY stance is unchanged).
- *Context-relative dockerfile.* A `build.dockerfile` unresolvable at the
  repo root and the compose dir resolves against the context, with a guard
  against absolute and remote contexts. immich's `immich-machine-learning`
  now binds `machine-learning/Dockerfile`, and its COPY sources
  (`immich_ml`, `ann`) and entry resolve against the context, so the ML
  service's building carries real source for the first time.
- *Context-scoped COPY resolution.* When the context is not the repo root, a
  COPY source or entry token matching nowhere at the repo root resolves
  against `<context>/`. Repo-root matches keep winning, so the monorepo
  convention is untouched.

One deliberate departure from the Direction, recorded here: the Direction
read "a relative `dockerfile` resolves against the context, not the repo
root", and the implementation resolves the context **last** — repo root
first, then the compose dir, then the context. A context-relative
`dockerfile: Dockerfile` next to a repo-root `Dockerfile` would otherwise
bind the wrong file in every monorepo built from the root (the convention
HEURISTICS.md records), so the context is a fallback, not the first resort.

Paperclip verification, per the Direction's "verify the paperclip
deps-stage case separately": confirmed against a generated
`deploy-shape.json` — the `paperclip` and `server` services both bind their
Dockerfile, and the attributed copies are exactly the deps-stage
per-package `package.json` manifests plus `scripts/docker-entrypoint.sh`;
the `COPY --from=build /app /app` stage attributes nothing. Binding succeeds
while staged artefacts attribute nothing, as predicted; whether the
deployment view wants the first-party stage instead is left open with the
other COPY-attribution questions (HC-024's precision cluster).

Fixture: a new private `packages/ml` built by a compose service
`build: context: packages/ml` with no `dockerfile` key; a generate-map
assertion pins the bound service's `service-source`/`entry-point` attributes.

## HC-018: A Standalone Root Dockerfile Declares No Deployment

**Rules:** D1 (one host per compose file), D3.

**Evidence.** ollama-code has a root `Dockerfile` (node:20-slim, installs the
built `cli` and `core` tgz packages globally, `CMD ["gemini"]`) and no
compose file. D1 only creates host districts from compose, so
deploy-shape.json has `hosts: []` and the repo's one real containerised
deployment — the image a user actually pulls and runs — is invisible. The
same holds for any repo whose only deployment declaration is a Dockerfile.

**Direction (to decide).** Treat an inventoried Dockerfile with no compose
owner as a single-service host district: name from the repo basename (D2's
fallback), rooms from its COPYs, entry from ENTRYPOINT/CMD per D3, infra
classification from nothing (it is whatever the image runs). Needs a guard
against double-counting when compose *also* builds the same Dockerfile, and
a stance on Dockerfiles that are clearly dev or test images.

## HC-019: Client-SDK Table Misses Common SDKs and Cannot Resolve Endpoints

**Rules:** D17 (service client SDKs), D13 (embedded databases), M6 (env-token
externals), M10 (delivers edges).

**Evidence.** Four failure shapes, each seen live:

- *Missing SDKs.* excalidraw's app depends on `firebase` (Firestore and
  Storage), `socket.io-client` (the collab server), and `@sentry/browser`
  (error tracking). None is in the D17 table, so all three externals are
  absent — the app reads as a lone SPA. paperclip's `embedded-postgres`
  dependency (root, server, and db packages) is absent from D13's table, so
  the compose-free deployment mode (postgres in-process) is invisible.
- *Endpoint resolution.* ollama-code reaches its model backend through the
  `openai` SDK pointed at an OpenAI-compatible base URL
  (`openaiContentGenerator.ts`: `OLLAMA_BASE_URL || OPENAI_BASE_URL ||
  http://localhost:11434/v1`). D17 sees the `openai` import and emits
  "OpenAI API" — the map names the wrong system, and the default (a local
  ollama server) is the map's biggest factual gap.
- *Split by purpose.* One SDK can front several externals: firebase is
  Firestore *and* Storage. The archify diagram draws two nodes with distinct
  edges (sync scenes vs binary files); D17 folds one node per service.
- *Hardcoded endpoints.* ollama-code's clearcut logger posts telemetry to
  `play.googleapis.com` from source (`clearcut-logger.ts:129`). D12 reads
  https URLs only from a package-root `config.yaml`; no rule reads URL
  constants from source.

**Direction (to decide).** Extend the D17 table (firebase, socket.io,
sentry) and D13's (embedded-postgres); add an endpoint-resolution step that
traces an SDK's base URL through env fallbacks (the M6 window is the model)
so `openai` + `OLLAMA_BASE_URL` reads as ollama, and consider one node per
resolved purpose rather than per SDK. Decide whether a URL constant in
deploy-reachable source is a D12-class signal.

**Resolution (Done, two of the four arms).**

- *Table extensions.* D17 gains `firebase` ("Firebase"), `socket.io-client`
  ("Socket.IO server"), and `@sentry/*` ("Sentry"); D13 gains
  `embedded-postgres` ("PostgreSQL database"). Excalidraw's map now shows
  Firebase, the Socket.IO collab server, and Sentry; paperclip's shows the
  embedded-postgres database node.
- *Endpoint resolution.* An override table (`ENDPOINT_ENV_OVERRIDES` in
  `scans.ts`) names, per backend, the env var and the SDKs it can redirect.
  In the shared pass (`inferExternalServiceUse`), when an importer file of a
  scoped SDK references the env var, the service resolves to that backend
  before `onImporters` — so both modes name it — and services resolving to
  the same backend fold to one node with unioned dep names and re-discovered
  importers. ollama-code's `openai` SDK now reads as "Ollama (endpoint
  resolved...)" while `@google/genai` keeps "Google Gemini API" — the two
  live in the same file there, which is why scoping the override to the
  base-URL-routing SDK matters. The Direction's "the M6 window is the model"
  is adapted, not copied: the window's intent (a match must not fire on
  nearby prose) is implemented as comment-stripped matching
  (`stripJsComments`), because the failure the ±4-line window guards —
  adjacent blocks in a config file — has no source-file analogue.
- *Deferred: purpose split and source URLs.* One node per resolved purpose
  (firebase's Firestore vs Storage) needs import-level use analysis, not just
  SDK presence — left, recorded in HEURISTICS.md's D17 failure modes. A
  hardcoded URL constant in source (ollama-code's clearcut endpoint) is a
  D12-class extension and stays open there.

Two defects found by the live repos while landing this, both covered by unit
tests: the resolution must read every file of a per-file index entry's node
id (they share ids), and the fold must re-discover importers over the unioned
dep names. Fixture: `packages/api/src/ai.ts` now points its `openai` SDK at
`OLLAMA_BASE_URL ?? localhost:11434/v1`, so the fixture's "OpenAI API"
external resolves to Ollama and folds with `@mini/service`'s `ollama` SDK
external — the D17 generate-map assertion pins the resolved node and the
absence of any "OpenAI API" external; goldens regenerated.

## HC-020: D1 Folds Distinct Services That Merely Share a Name

**Rules:** D1 (service folding across compose files, added by HC-009).

**Evidence.** HC-009's fix folds a service name recurring across a
directory's compose files to one owner node. supabase shows the over-fire:
`docker-compose.kong.yml` defines `api-gw` with image `kong/kong:3.9.3`
while `docker-compose.yml` defines `api-gw` with envoy — alternative
gateways a self-hoster chooses between, not duplicates. Name-folding
shadows the kong node, so the canonical kong topology is unreachable on the
map. The same file's logs topology defines its own `studio` (the logflare
dashboard, no image) which folds into the Supabase host's `supabase/studio`
node — a different service erased.

**Direction (to decide).** Make image identity the fold key: same name *and*
same (or absent) image folds; same name with different images stays
distinct, tagged as the variants they are. Check the interaction with the
environment-variant dedup (which compares service-name sets, not images) and
that immich's single `Db` does not regress.

**Resolution (Done).** Image identity entered D1 at BOTH layers:

- *Ownership key.* `serviceOwnerKey` pairs the directory with the name and
  image; `isServiceShadowed` takes the service, so a same-named service
  shipping a different image is never shadowed (supabase's kong and envoy
  `api-gw` are distinct). D6's carried deps resolve the dep's image from its
  variant service so the key matches the claim.
- *Variant dedup.* Landing the key exposed that the kong host was in fact
  erased one layer earlier — the >=50% environment-variant dedup compared
  service-NAME sets, so the caddy file "covered" the kong topology. Coverage
  now counts a service only when name AND image match. Two consequences
  handled deliberately: a dev-ranked variant keeps the name-only dedup (its
  build blocks replace the canonical images wholesale; supabase's
  `docker/dev/` variant and the `tests/` composes would otherwise surface as
  districts), and test-directory composes are excluded from D1 outright. Two
  additions beyond the Direction's literal sentence, both deliberate (REVIEW-0009):
  the test-compose exclusion (I4 made part of D1's scan — without it the
  identity dedup leaks `tests/`/`dev/` composes as districts) and a variant
  tag — the Direction's "tagged as the variants they are" — each
  same-named/different-image service node carries an `alternative` tag so a
  reader sees alternatives rather than duplicates. The dev carve-out's
  breadth (all rank-1 variants, not just supabase's) is a recorded judgement,
  pinned by the dev-variant dedup unit test.

Verified on live supabase: the Kong host returns with its own api-gw; the
Dev/Test host districts that briefly surfaced are gone; supabase's other
variant hosts (pg15, pgbouncer, s3, rustfs) are unchanged, and immich's
single `Db` does not regress. Fixture: alternative-proxy composes (envoy/
kong/caddy sharing `api-gw`) plus a tests-dir compose and a dev variant;
hosts.ts unit tests pin all three.

## HC-021: Every Non-Private Workspace Library Becomes a Published Deployable

**Rules:** D14 (published-artefact classification).

**Evidence.** D14's published signal is `private: true`'s absence plus a
declared entry. paperclip's release workflow does publish its packages, but
the deployment map shows ~20 `published` deployables — every adapter,
gateway, plugin, `shared`, `db`, `eslint-config`-class package — when the
runtime reality is one server image that bundles them (the Dockerfile
COPYs the packages; the CLI and the server are the artefacts a user runs).
supabase shows the same inversion: `eslint-config-supabase`, `api-types`,
and `shared-data` rate deployables while the studio app (HC-022) does not.
The `published` tag stops meaning "ships to users".

**Direction (to decide).** Discount a workspace library whose files land in
a host image via D3 COPY membership: it is a component of that deployment
(a building inside the host), not an artefact of its own. Alternatives: a
release-evidence signal (a publish workflow or `files`/`publishConfig`
content) as a second gate; or a milder `bundled` tag keeping the node but
demoting the deployable status. Care needed where a package is *both*
bundled and genuinely published (paperclip's adapters may be exactly that).

## HC-022: Next.js Apps Are Not Runnable; `docs` Dirs Are Not Apps

**Rules:** D16 (runnable app), I3 (directory ignore set).

**Evidence.** Two compounding misses on supabase. D16 recognises a web-role
SPA entry or a `start` script that calls `Bun.serve`/`.listen`/
`createServer`/fastify/express — `next start` matches none of them, so
`apps/studio`, `apps/www`, and `apps/learn` (real Next.js deployments with
their own hosting) appear only as plain code districts, while trivial
libraries take the deployable slots (HC-021). Separately, I3's ignore set
excludes any directory named `docs`, which swallows `apps/docs` — a deployed
Next.js site — whole; the documented I3 failure mode, but here it deletes a
product.

**Direction (to decide).** D16: add Next/Nuxt/SvelteKit-style framework
start scripts (`next start`, `next dev`?) and recognise the framework's
entry conventions; keep `next build`-only packages out. I3: the
directory-name ignore set should not apply at `apps/`/`packages/` depth
inside a workspace (a `docs` *member package* is a package first), or
should yield when the directory has its own `package.json` with an entry.

## HC-023: In-Host Service Calls and Monitoring Scrapes Draw No Edges

**Rules:** a new inference rule in the D or M groups; D6 (depends_on only).

**Evidence.** The edges that make a deployment map read as a *system* are
service-to-service calls, and the generator draws none of them. immich's
server calls its ML container over HTTP
(`server/src/repositories/machine-learning.repository.ts` posts to the
`immich-machine-learning` host) — the map shows both nodes with no edge.
paperclip's server serves the UI bundle (`SERVE_UI=true`); the UI floats as
an independent D16 app with no relationship to the server that ships it.
supabase's studio reaches every service through the api-gw. And immich's
`docker/prometheus.yml` `scrape_configs` name the server's metrics ports,
yet Prometheus and Grafana sit as isolated leaves — D6 reads only
`depends_on`.

**Direction (to decide).** Two candidate rules. (a) In-host HTTP call
inference: a `fetch`/axios/SDK call whose target host or port resolves to a
sibling service's declared ports or hostname (compose service names,
`ports:`, env config) draws a declared `data_flow` caller -> service. (b)
Monitoring: `scrape_configs` job targets matching a service's container name
or port draw a scrape edge prometheus -> service. Both need the resolved
host topology from D1/D3 as input, so they sit downstream of it. Risk:
HTTP-target matching is where guesses start — hold to targets that resolve
to a *declared* service.

## HC-024: Inferred Edges Over-Fire; Templates and Dev Environments Present as Production

**Rules:** M8 (SQL forms), M10 (delivers), D17 (double edges), D7 (wrangler),
D3 (dev-environment compose).

**Evidence.** A precision cluster from the same comparison run:

- *M8 on browser code.* paperclip's React SPA and supabase's
  studio-pages/www-pages modules draw inferred read/write edges straight
  into postgres — SQL-write regexes firing on string literals or ORM-ish
  receivers in client code that actually goes through REST. Implausible
  topology, drawn with 0.75 confidence.
- *M10 on build scripts.* ollama-code's `scripts/` modules "deliver" to
  Google Gemini via the env-prefix sweep; build scripts ship no prompts.
  ~17 inferred edges, most ungrounded.
- *Double-drawn relationships.* Each OpenAI-using module in supabase emits
  both a D17 `uses` (0.7) and an M10 `delivers` (0.6) edge for the same
  SDK import. One relationship, two edges.
- *D7 on a template.* paperclip's `edge-delivery`/`edge-worker` district
  comes from `packages/plugins/sandbox-providers/cloudflare/bridge-template/
  wrangler.jsonc` — a template copied into *user* projects, not a worker
  this repo deploys.
- *D3 on a dev container.* mermaid's host gateway is a dev environment:
  the Dockerfile bind-mounts the whole repo, runs dev servers, keeps a pty.
  It presents as a production service with ports.

**Direction (to decide).** Per item: M8 could require a server-side
receiving module (the node already starts a server or the SDK import is
server-runtime) or demote UI-dir hits; M10 could exclude script/QA dirs it
inherits from R1's sets; D17+M10 should suppress M10 when D17 already drew
the same pair; D7 could skip configs under a directory named `*-template*`/
`*template*` or one not referenced by any deploy mechanism; D3 could tag a
compose host `dev-environment` on bind-mounting the repo root or running
known dev servers (a tag, not exclusion — excalidraw's dev-args compose
shows the same shape and its judgement is subtler).

## HC-025: Platform Deploy Configs (Netlify, Vercel, ECS, Quadlet) Go Unseen

**Rules:** a new D-group family; D1 covers compose only.

**Evidence.** Three repos declare deployments through configs no rule reads.
mermaid's `netlify.toml` deploys the live editor (`publish =
"mermaid-live-editor/docs"`, build via `scripts/editor.bash`); excalidraw's
`vercel.json` declares the app's real production hosting (the compose file
is the self-host path); paperclip's `docker/ecs-task-definition.json` and
`docker/quadlet/` systemd units declare container deployments beside the
compose files. None appears anywhere in the maps.

**Direction (to decide).** A rule per config family or one generic
"deployment config" rule: netlify/vercel yield a site deployable (name from
the config, entry from `publish`/output dir, build from the command); ECS
task definitions and quadlet units yield host districts the way compose
does (containers, images, port/dependency edges). Each family is small; the
risk is table sprawl — maybe land them one at a time, evidence-led.

## HC-026: Non-Node Services (Python) Are Never Inventoried

**Rules:** I1 (inventory), D17 (client SDKs).

**Evidence.** immich's `machine-learning/` is a real deployed service — its
own container, its own Dockerfile — built in Python (`pyproject.toml`,
`immich_ml/` package). The inventory is Node-shaped: no pyproject/uv entry
detection, so the package never becomes a deploy root, no rooms form, and
the service exists on the map only as a D5-classified infra shell (a
`gateway` by service-name fallback, with no source behind it — itself
misleading, see HC-017). Its dependency scan also misses
`huggingface-hub`/`transformers` in pyproject, so the model-download flow to
Hugging Face (a defining behaviour of the service) draws nothing.

**Direction (to decide).** An I-group extension: a directory with
`pyproject.toml`/`uv.lock`/`requirements.txt` is a package whose rooms come
from its layout (`immich_ml/...`). Scope the first cut to making the
*deployment* node real (bound via HC-017's D3 fix, entry from the
Dockerfile CMD); the import-graph interior and a pyproject D17 scan are
follow-ups. A language-family decision is implied: how far past
TypeScript/JavaScript is the generator willing to go?

## HC-027: D14 Entry Resolution Misses Conventional Entries

**Rules:** D14 (published-artefact classification, source-entry resolution).

**Evidence.** D14 resolves a published package's source entry through
dist->src and `.m/cjs`->`.ts` conventions, then `src/index.ts`/`index.ts`/
`src/main.ts`. Entries outside that list lose their deployable. mermaid's
headline package (`mermaid`, non-private, `module: ./dist/mermaid.core.mjs`)
resolves to a `src/mermaid.ts` that is not in the convention list, so it
renders as a plain module while `tidy-tree` and `parser` (which happen to
have `src/index.ts`) take the `published` slots; `@mermaid-js/layout-elk`,
`mermaid-zenuml`, and `tiny` are likewise missing or demoted. ollama-code's
VS Code extension (`engines.vscode`, `main: ./dist/extension.js`) fails the
same way: the package shows only as an `esbuild.js` worker room, never an
`extension` deployable. HEURISTICS.md records the failure mode ("a bundled
library whose source entry is neither the declared path nor a conventional
`src/index.ts` gets no deployable") without candidates.

**Direction (to decide).** Extend the resolution chain: a package-name-derived
entry (`@mermaid-js/parser` -> `src/parser.ts`), a `.d.ts`-typed dist entry
back-mapped to source, and an entry that is the dist path itself when no
source match exists (keep the node, cite the dist file). Worth pairing with
HC-021 since both reshape D14's deployable set.

**Resolution (Done, chain extended; dist-cite deferred).** The candidate
chain in `artefactEntryCandidates` gains, in order: `./`-segment
normalisation of the declared entry (ollama-code's VS Code extension
declares `./dist/extension.js`; the unnormalised `./src/extension.ts` never
matched the inventory, so the extension was never a deployable); the
manifest `types`/`typings` entry recorded on the artefact and mapped
`dist/x.d.ts` -> `src/x.ts` (mermaid-zenuml's real entry is
`src/detector.ts`); and package-name-derived `src/<name>.ts` (mermaid's
headline package enters at `src/mermaid.ts`). Verified live: mermaid's
`mermaid`, `mermaid-zenuml`, and `mermaid-layout-elk` join the published
deployables; ollama-code's extension reads as one. The dist-cite fallback
("keep the node, cite the dist file") is deferred: a package with no source
rooms at all (@mermaid-js/tiny, no src in the repo) has no node to keep, and
giving it one is HC-028's package-container work — recorded there-shaped in
HEURISTICS.md's D14 failure modes. Also worth pairing with HC-021 as the
Direction noted: the chain now resolves MORE packages into deployables,
which sharpens the bundled-library question.

## HC-028: Residual Packages Fragment and Orphan Their Root Files; Districts Label by Directory, Not Artefact Role

**Rules:** M3 (residual-package assembly), S4 (loose-file grouping), the
district-label rule; HC-003's deferred residual is its sibling on the normal
(non-residual) path.

**Evidence.** immich's deployment map, 2026-09: three nodes sit outside every
district — `packages/plugin-core/src` (a bare deployable labelled "Src"),
`packages/plugin-core/esbuild.js`, and `packages/plugin-sdk/esbuild.js` +
`plugin-sdk.mjs` (two "Top-level files" nodes). All three come from M3's
residual path ("Residual packages (partly claimed by compose services)
instead yield a district per structured dir and district-less nodes for flat
dirs"):

- plugin-sdk **is** baked into the server image (`COPY ./packages/plugin-sdk`),
  so it survives as a residual package. Its `src/` gets a per-directory
  district ("D6 Src") — a *directory* container, not a *package* container —
  and its loose root files belong to no structured dir, so the residual path
  has nowhere to put them and they render district-less.
- plugin-core is **not** actually host-deployed: the server Dockerfile only
  layer-caches its `mise.toml`, which attributes nothing. It is spared by D14
  as a published artefact (`main: src/index.ts`); its `src/` holds exactly
  one file, and M3 never wraps a single synthetic building, so the room is
  promoted to a bare district-less deployable labelled "Src", leaving
  `esbuild.js` orphaned too. (This also corrects HC-007's resolution, which
  recorded plugin-core as baked into the server image — only its `mise.toml`
  is copied, so it is on the map as a published artefact, not as a deployed
  package.)

The same examination exposes a naming gap across the map: "D5 Src"
(@immich/cli), "D6 Src" (@immich/plugin-sdk), and "D2 Immich"
(@immich/server) all name districts by directory or bare package, when each
package deploys as one artefact — CLI, Plugin SDK, Server (the host building
is already "Immich Server"; the district disagrees).

**Direction (to decide).** Three linked changes, M3-first:

1. *Residual assembly grows a package-level container.* A residual package
   gets one district (labelled by the package, below) holding its structured
   dirs as buildings; its loose root files attach to that district as a
   support room (or collapse when they are build scripts of the package's one
   artefact). The single-synthetic-building guard then applies at the
   *package* level, not per directory — plugin-core's one-file `src/` plus
   `esbuild.js` becomes the "Plugin Core" district with its deployable
   entry, not a bare "Src" and an orphan.
2. *Artefact-role labels.* A code district whose package deploys as one
   artefact takes the artefact's role name — the package name scope-stripped
   ("Plugin SDK"), the deployable's tag ("CLI"), or the host service's role
   ("Server") — instead of the directory name ("Src") or the scoped package
   display name ("Immich"). This dissolves the bare "Src" district labels
   HC-003's residual also chases, and needs a decision on the name source's
   precedence (tag vs package name vs D14 entry).
3. *Where the two paths meet.* The normal path's package districts and the
   residual path's new package districts should be one shape; check whether
   change 1 makes the residual branch of M3 expressible as the normal branch
   with a spared-package flag, which would retire the per-structured-dir
   special case outright.

Risk: district labels feed the viewer's rail and grouping; relabeling
"Immich" -> "Server" touches goldens across every sampled repo and should
land with HC-003's residual rather than twice.

**Resolution (Done, assembly unified; full Src collapse still deferred).**

- *One package district per package, residual or not.* M3's residual special
  case (a district per structured dir, district-less flat nodes) is retired:
  every package creates its `${pkg.id}-area` district, claimed rooms filter
  out as before, and the leftover rooms AND loose root files group under it.
  The single-synthetic-building guard stays per-package in effect — a
  package whose content is one room plus root files reads as the district
  holding a deployable and a support room, not a bare "Src" and orphans.
  Verified live on immich: zero district-less nodes; plugin-core is the
  "Plugin Core" district holding its entry and `esbuild.js`; plugin-sdk's
  root files live under "Plugin Sdk".
- *Artefact-role labels.* `packageDistrictLabel` labels a package district:
  the artefact role when unique repo-wide (the one CLI package reads "CLI"),
  else the claiming host service's role when its name starts with the
  package's (immich's `immich` package, claimed by the `immich-server`
  service, reads "Server"), else the scope-stripped package name ("Plugin
  Sdk", "Server" for @immich/server). The bare "Src" district labels and the
  "D2 Immich"-style package-name districts are gone across the sample. The
  claim search found a wrinkle worth recording: a ROOT-level package's
  claimed dir (`server` — no `/`) never entered `serviceClaimedDirs`, so the
  `immich` package was not flagged residual; the label search therefore keys
  on the claiming service directly, not on the residual flag.
- *The Direction's precedence question, decided (REVIEW-0009).* The name
  source order is: CLI tag when the package is the repo's ONLY cli-tagged
  artefact ("CLI"; the uniqueness gate exists because aria-tools' twenty CLI
  districts must not collapse to twenty identical "CLI" labels), then the
  claiming service's role word when the service is the package's name plus
  one known role word ("Immich Server" -> "Server"; a curated word table —
  server/worker/cli/gateway/web/api/agent/daemon/app, the D5/D17 pattern —
  so `media-db` over the `media` package does not read "Db"), else the
  scope-stripped package name. The Direction's "D14 entry" arm is subsumed:
  an entry basename differing from the package name (mermaid's
  `src/mermaid.ts` vs package `mermaid`) is the same word in the sampled
  repos, so the package name arm covers it; revisit if a repo contradicts.
  The Direction's "collapse when they are build scripts" arm is declined in
  favour of attach: R1 classes build scripts operational deliberately, so
  they stay visible as the district's support room rather than vanishing.
- *HC-003's residual (the bare `Src` BUILDING on the normal path) is not
  collapsed here*: a multi-room `src/` building inside its district is
  HC-003's deferred concern (promote files, move the deployable marking to
  the entry room); landing both label and structure changes in one pass
  would have made the golden diffs unreviewable. The deferred item stands.
- *Deferred from the Direction:* the dist-cite fallback (a package with no
  source rooms at all keeps a node citing its dist entry) — recorded in
  HC-027's resolution; the unify check (change 3) partially succeeded: the
  residual and normal branches now share the district-creation and room-
  parenting code, with `residual` reduced to an R5-flag and the label hint.

Fixture: a `packages/plugin` published package (single-file `src/`, a root
`esbuild.js` referenced by a build script) pins the package district holding
both; generate-map assertions pin the api residual unification, the plugin
district, and the CLI role label; unit tests pin `packageDistrictLabel`'s
three arms.

## Repositories Examined

| Repo | Shape | Modes run | Deployment map verdict |
| --- | --- | --- | --- |
| aria-evals | Deployment-shaped, multi-host | deployment, ov | Good: the design target |
| aria-tools | Tooling monorepo, ~20 CLIs | deployment, ov | Degenerate: 42 workers, 0 deployables (HC-001) |
| nzlaw | Small, two packages | deployment, ov | Reasonable |
| functionary.dev | Cloudflare edge app | deployment, ov | Good but sparse (edges by mode design) |
| immich | Self-hosted server, 10 compose files | deployment, ov | Core shape captured; scaffolding over-ranked (HC-007); ML service invisible (HC-017, HC-023, HC-026); residual packages fragment (HC-028) |
| mermaid | Diagramming library, plugins | deployment | Wrong: CI jobs as deployables (HC-001, HC-005); dev container as host (HC-024); headline package not a deployable (HC-027) |
| ollama-code | CLI, core lib, VS Code extension | deployment | Wrong backend named (HC-019); Dockerfile invisible (HC-018); M10 noise (HC-024) |
| excalidraw | Self-host app plus published library | deployment | App captured; the library invisible (HC-001, HC-008); Firebase/Sentry/collab externals missing (HC-019); host unbound (HC-017) |
| paperclip | Design tool: server, db, 44 packages | deployment | Real shape captured; deployable inflation (HC-021), template wrangler (HC-024), M8 noise (HC-024) |
| supabase | Postgres platform, ~15 compose files | deployment | Full stack found but services duplicated 2-6x (HC-009, HC-010); kong folded away (HC-020); apps missing (HC-022) |
| aria | Agent executable, spawned daemons, SDK | deployment | Missed its whole shape: executable + daemons (HC-001, HC-012) |
