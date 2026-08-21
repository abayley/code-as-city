# Heuristics catalogue

Every rule the deterministic generator applies, with its signal, action, and
known failure modes. Code references are sections of `src/generate-map.mjs`.
Rules are grouped and numbered by stage; the IDs are stable, so map warnings
and commit messages can cite them.

## Inventory (I)

| ID | Signal | Action |
| --- | --- | --- |
| I1 | `.git` present | Inventory via `git ls-files` (respects .gitignore); fall back to a directory walk |
| I2 | A directory contains its own `.git` | Excluded entirely (vendored third-party checkout, e.g. a langfuse clone) |
| I3 | Directory name in the ignore set (`node_modules`, `dist`, `generated`, `docs`, ...) | Excluded entirely |
| I4 | Path segment in `test`/`tests`/`__tests__`/`coverage`/`test-database`, or filename matching `*.test.*`, `*.spec.*`, `*_test.*` | Excluded from source analysis |
| I5 | Filename matching `*.config.{ts,js,mjs,cjs}`, `*-setup.*`, or `.*rc.js` | Tool configuration pretending to be code: excluded from source analysis (still visible to config-driven rules such as D7) |

Failure modes: I3 excludes `docs/` even when it contains real code (accepted
by decision); I2 depends on the nested checkout retaining its `.git`.

## Structure (S)

| ID | Signal | Action |
| --- | --- | --- |
| S1 | `package.json` | A package. `bin` -> CLI; react/next/vinext/vue/svelte dep -> web app; otherwise generic |
| S2 | First path segment within a package | A room. A dominant segment holding >60% of files (e.g. `src/`) is expanded one level (`src/ingest`, `src/lib`, ...) |
| S3 | Import specifiers | Resolved relative paths, `@/` alias to package root, NodeNext `./x.js` -> `x.ts`, bare specifiers matching sibling package names |
| S4 | A loose file with file-level fan-in 0 inside a promoted building | Its own room, named after the file (a CLI, an installer); imported loose files group as a support-files room |

Failure modes: S3 does not read tsconfig `paths` beyond `@/*`; S2's 60%
threshold is untuned beyond the test repos.

## Deployment shape (D)

| ID | Signal | Action |
| --- | --- | --- |
| D1 | `docker-compose*.yml` | One host district per compose file. Overlays (`*.override.yml`, `*.build.yml`) skipped. Environment variants deduped when a higher-ranked host covers >=50% of a host's services; rank prod > uat/staging > example > unqualified > dev |
| D2 | Compose file path | Host name from informative path segments (generic segments like `deploy` dropped) |
| D3 | Service `build.dockerfile`, or `images/<service>.Dockerfile` convention | Service bound to its Dockerfile; `COPY src/...` lines become the service building's rooms; ENTRYPOINT/CMD names the entry room |
| D4 | Crontab line running `compose run <service>` | Service tagged `cron` (scheduled job), schedule recorded |
| D5 | Container image name, else service name (`database`, `redis`, `proxy`, ...) | Infra classification: database/queue/storage/gateway/cloud |
| D6 | `depends_on`, harvested across ALL compose variants by service name | `depends_on` edges between the surviving host's services. A dependency only present in a deduped variant (dev-only database container) is carried onto the host as an infra node |
| D7 | `wrangler.toml/json/jsonc` | A Cloudflare edge district with the worker (entry from `main`) and D1 bindings; `drizzle.config.*` contributes a database node |
| D8 | Wrangler present and the owning package has an entry dir (`app`, ...) | `deploys` edge from the entry room to the edge worker |

Failure modes: D1's rank list and 50% threshold are conventions; D3 assumes
COPY paths are repo-relative; D5's tables are small and vendor-biased.

## Coupling (C)

Computed from the import graph; matches archunitts fan-in/fan-out/instability
(instability = out / (in + out)).

| ID | Signal | Action |
| --- | --- | --- |
| C1 | All import edges | Per-file and per-room fan-in, fan-out, instability; written to `coupling.json` |
| C2 | Room fan-in >= 3 and instability <= 0.25, and NO file in the room is significantly mid-coupled (degree >= 5, 0.25 < instability < 0.8) | Room eliminated as a shared utility leaf. A mid-coupled file (e.g. an annotation-store) anchors its room against elimination |
| C3 | Eliminated rooms exist for a package | They reappear once as a "Shared libraries" structure with aggregated import-count edges from every campus node using them. Parented to the package's district when it exists; district-less (implicit System neighbourhood) only when it does not |

Failure modes: C2 thresholds validated only on aria-evals/functionary.dev/
aria-tools; C2 fires on self-contained tools whose lib serves one package
(accepted, given C3's parenting); the district-less C3 fallback requires the
patched viewer.

## Reachability (R)

| ID | Signal | Action |
| --- | --- | --- |
| R1 | Deploy roots: files COPY'd into service images, Dockerfile entrypoints, wrangler main, package bin/main, web entry dirs. Script roots: path tokens in package.json script commands. Script entries split by name: QA (`check`, `lint`, `test`, `adr`, `prepare`, `proof`, `uat`, ...) versus operational (`bootstrap`, `certificates`, `backfill`, ...) | Three reachability sets over the import graph: deploy, script, operational |
| R2 | File reachable only from QA scripts and from nothing that deploys | Dev tooling: stripped at FILE granularity (one operational CLI in `scripts/` survives while QA utilities around it vanish); emptied rooms disappear. Every strip is recorded in map warnings |
| R3 | Room with zero fan-in, unreachable from deploy and script roots, no OTLP coupling, not an entry dir, not path-referenced | Orphan: excluded (examples/, unreferenced root config files) |
| R4 | A string literal resolving into another package's area (tried against both the file's dir and the package root, e.g. `resolve(packageRoot, "../../skills/map-codebase")`) | The referenced area is reassigned to the referencing package's district, with a declared `path reference` edge |

Failure modes: R1's QA/operational split is a naming convention (a
mis-named script entry flips its targets); R3's OTLP exemption is the only
thing keeping unreferenced-but-meaningful producers (plugins/) on the map.

## Map shaping (M)

| ID | Signal | Action |
| --- | --- | --- |
| M1 | A promoted node's source references `@opentelemetry/`, `otlp`, or `OTEL_EXPORTER` and a collector node exists | Inferred `data_flow` edge (confidence 0.7, "OTLP export") to the collector, preferring the gateway host's |
| M2 | Entry rooms (`bin`, `app`, `routes`, ...) and the room import graph | `flowLayer` by longest path from entries; infra sits downstream |
| M3 | Package districts | Never wrap a single synthetic building: rooms are promoted into the district (entry dirs as gateways, structured dirs as buildings). Residual packages (partly claimed by compose services) instead yield a district per structured dir and district-less nodes for flat dirs |
| M4 | Assembly complete | Final sweep drops any edge whose endpoint was excluded by a later rule |
| M5 | Host config exporter endpoint/env lines matching another host's name or another host's service name (kebab~snake normalised, >=6 chars) | Declared `data_flow` between the hosts' primary services (gateway collector -> stack collector; stack collector -> span-ingest) |
| M6 | Exporter endpoint env token naming nothing internal (LANGFUSE_OTLP_ENDPOINT), with a +/-4-line window guard against internally-named blocks | Declared external cloud node with a `data_flow` edge from the exporting service |
| M7 | A campus node's files start a server (Bun.serve, .listen, createServer) or construct HTTP clients (fetch, axios) | Tags `listens` / `http-client` |
| M8 | A campus node's files contain SQL write forms (`insert into`, `delete from`, `update ... set`) or ORM write calls on a database-ish receiver (`db.insert(...)`); reads via `select ... from` / `db.select(` | Inferred `data_flow` (confidence 0.75): writes flow node -> database, reads flow database -> node; target is the same-district database node, else the map's only one |

## Overview mode (O)

`--overview` produces a whole-codebase module map instead of the deployment
map: dev-tooling and orphan exclusion are skipped, and import edges are
omitted by design (only data flow is drawn).

| ID | Signal | Action |
| --- | --- | --- |
| O1 | Single package | One district per top-level directory (S2 segmentation, so `src/` expands a level: src/lib, src/ingest, ...); multi-package repos get one district per package |
| O2 | Module granularity inside a district | Subdirectories and standalone files are modules. The imported-loose-files bucket is dissolved: every file is its own module. Fan-in-0 modules are `composer` (front row); imported ones are `support` (row behind, 72% size, rendered as pyramids) |
| O3 | Files matching `**/migrations/<digits>[-_.]...` | Collapse to one leaf module per migrations directory ("Migrations (N)") |
| O4 | >=60% of a district's modules are utility (fan-in >= 2, instability <= 0.33) | District coloured as shared code (purple) instead of function area (teal) |
| O5 | Lines of code and cyclomatic complexity | Height = 0.55 + loc/320 (floor 0.6, no ceiling); footprint = 0.85 + sqrt(complexity)/7 (clamped 0.95-3.4) |
| O6 | TypeScript compiler API available | McCabe complexity per function (1 + decision points; logical operators and non-default `case` clauses count; nested functions counted separately), summed per file and module. Regex decision-point fallback otherwise |
| O7 | Deployment shape | One "Infrastructure & external" district: image-only services on surviving hosts, backing stores from ANY compose variant (dev-only postgres), env-token externals (M6 scan), wrangler worker, drizzle database |
| O8 | Flow edges | Declared collector chain from host-own configs (host-name and service-name matching as M5; a matched service resolves to the module owning its Dockerfile ENTRYPOINT); inferred OTLP producers -> gateway collector (M1 pattern); inferred database reads/writes (M8 patterns) against the database node |

Failure modes: O4's 60% cut is untuned (src/core and src/providers read as
function areas at file granularity); O7 groups all infrastructure into one
district rather than locating services on their hosts; O6 attributes
top-level statements' branches to the file rather than a function.

## Tuning constants

| Constant                             | Value                                            | Rule |
| ------------------------------------ | ------------------------------------------------ | ---- |
| Dominant-segment expansion threshold | >60% of package files                            | S2   |
| Utility elimination                  | fan-in >= 3, instability <= 0.25                 | C2   |
| Mid-coupling anchor                  | degree >= 5, 0.25 < instability < 0.8            | C2   |
| Host dedup coverage                  | >=50% shared services                            | D1   |
| OTLP edge confidence                 | 0.7                                              | M1   |
| Environment rank                     | prod 5, uat/staging 4, example 3, plain 2, dev 1 | D1   |
| Overview shared-district cut         | >=60% utility modules (fan-in >= 2, inst <= 0.33) | O4   |
| Overview height / footprint          | 0.55 + loc/320; 0.85 + sqrt(complexity)/7        | O5   |
