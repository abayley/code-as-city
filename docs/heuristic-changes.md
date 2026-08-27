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
The legibility and scale cluster — only HC-011 remains open (HC-003, HC-004,
HC-006 done; HC-002 rejected as based on incorrect evidence) — is being worked
directly, without an RFC.

## Status Key

- **Proposed** — evidenced, direction sketched, not yet decided.
- **Accepted** — decided; awaiting implementation.
- **Done** — implemented; moved to a one-line note with the commit.
- **Rejected** — considered and declined, with the reason kept.

## Candidate Index

| ID     | Title                                                       | Rules       | Status   |
| ------ | ----------------------------------------------------------- | ----------- | -------- |
| HC-001 | No deployment category for a published package              | new; D, M   | Done     |
| HC-002 | O4 shared-district colouring never fires                    | O4          | Rejected |
| HC-003 | Collapse a redundant sole `src/` level                      | S2, M3      | Done     |
| HC-004 | Disambiguate colliding module labels across packages        | O2, M3, S4  | Done     |
| HC-005 | CI maintenance workflows surface as deployables             | D9, D10, M3 | Done     |
| HC-006 | Emoji leak from workflow names into node labels             | D9          | Done     |
| HC-007 | Dev and test packages rank as peer districts                | S1, M3, R   | Done     |
| HC-008 | Monorepo root and generic hosts make empty districts        | S1, D2, M3  | Done     |
| HC-009 | Same service across compose files duplicates infra          | D1          | Done     |
| HC-010 | D5 name classification mislabels API layers as databases    | D5          | Done     |
| HC-011 | Overview emits one node per file; unrenderable at scale     | O2; viewer  | Proposed |
| HC-012 | Runtime-spawned daemons are invisible to the deployment map | new; D, M   | Done     |
| HC-013 | No deployment category for an app you run directly          | new; D16, R5| Done     |
| HC-014 | External systems (IMAP, LLM APIs) from client SDKs go unseen | new; M6/M10 | Proposed |
| HC-015 | Same-named packages merge silently at the room level        | S, rooms    | Proposed |
| HC-016 | Overview gold means both shared-district and .tsx module    | O4; viewer  | Done     |

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
