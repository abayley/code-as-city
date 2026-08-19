# Heuristics catalogue

Every rule the deterministic generator applies, with its signal, action, and
known failure modes. Code references are sections of `src/generate-map.mjs`.
Rules are grouped and numbered by stage; the IDs are stable, so map warnings
and commit messages can cite them.

## Inventory (I)

| ID | Signal | Action |
|---|---|---|
| I1 | `.git` present | Inventory via `git ls-files` (respects .gitignore); fall back to a directory walk |
| I2 | A directory contains its own `.git` | Excluded entirely (vendored third-party checkout, e.g. a langfuse clone) |
| I3 | Directory name in the ignore set (`node_modules`, `dist`, `generated`, `docs`, ...) | Excluded entirely |
| I4 | Path segment in `test`/`tests`/`__tests__`/`coverage`/`test-database`, or filename matching `*.test.*`, `*.spec.*`, `*_test.*` | Excluded from source analysis |

Failure modes: I3 excludes `docs/` even when it contains real code (accepted
by decision); I2 depends on the nested checkout retaining its `.git`.

## Structure (S)

| ID | Signal | Action |
|---|---|---|
| S1 | `package.json` | A package. `bin` -> CLI; react/next/vinext/vue/svelte dep -> web app; otherwise generic |
| S2 | First path segment within a package | A room. A dominant segment holding >60% of files (e.g. `src/`) is expanded one level (`src/ingest`, `src/lib`, ...) |
| S3 | Import specifiers | Resolved relative paths, `@/` alias to package root, NodeNext `./x.js` -> `x.ts`, bare specifiers matching sibling package names |
| S4 | A loose file with file-level fan-in 0 inside a promoted building | Its own room, named after the file (a CLI, an installer); imported loose files group as a support-files room |

Failure modes: S3 does not read tsconfig `paths` beyond `@/*`; S2's 60%
threshold is untuned beyond the test repos.

## Deployment shape (D)

| ID | Signal | Action |
|---|---|---|
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
|---|---|---|
| C1 | All import edges | Per-file and per-room fan-in, fan-out, instability; written to `coupling.json` |
| C2 | Room fan-in >= 3 and instability <= 0.25, and NO file in the room is significantly mid-coupled (degree >= 5, 0.25 < instability < 0.8) | Room eliminated as a shared utility leaf. A mid-coupled file (e.g. an annotation-store) anchors its room against elimination |
| C3 | Eliminated rooms exist for a package | They reappear once as a "Shared libraries" structure with aggregated import-count edges from every campus node using them. Parented to the package's district when it exists; district-less (implicit System neighbourhood) only when it does not |

Failure modes: C2 thresholds validated only on aria-evals/functionary.dev/
aria-tools; C2 fires on self-contained tools whose lib serves one package
(accepted, given C3's parenting); the district-less C3 fallback requires the
patched viewer.

## Reachability (R)

| ID | Signal | Action |
|---|---|---|
| R1 | Deploy roots: files COPY'd into service images, Dockerfile entrypoints, wrangler main, package bin/main, web entry dirs. Script roots: path tokens in package.json script commands. Script entries split by name: QA (`check`, `lint`, `test`, `adr`, `prepare`, `proof`, `uat`, ...) versus operational (`bootstrap`, `certificates`, `backfill`, ...) | Three reachability sets over the import graph: deploy, script, operational |
| R2 | File reachable only from QA scripts and from nothing that deploys | Dev tooling: stripped at FILE granularity (one operational CLI in `scripts/` survives while QA utilities around it vanish); emptied rooms disappear. Every strip is recorded in map warnings |
| R3 | Room with zero fan-in, unreachable from deploy and script roots, no OTLP coupling, not an entry dir, not path-referenced | Orphan: excluded (examples/, unreferenced root config files) |
| R4 | A string literal resolving into another package's area (tried against both the file's dir and the package root, e.g. `resolve(packageRoot, "../../skills/map-codebase")`) | The referenced area is reassigned to the referencing package's district, with a declared `path reference` edge |

Failure modes: R1's QA/operational split is a naming convention (a
mis-named script entry flips its targets); R3's OTLP exemption is the only
thing keeping unreferenced-but-meaningful producers (plugins/) on the map.

## Map shaping (M)

| ID | Signal | Action |
|---|---|---|
| M1 | A promoted node's source references `@opentelemetry/`, `otlp`, or `OTEL_EXPORTER` and a collector node exists | Inferred `data_flow` edge (confidence 0.7, "OTLP export") to the collector, preferring the gateway host's |
| M2 | Entry rooms (`bin`, `app`, `routes`, ...) and the room import graph | `flowLayer` by longest path from entries; infra sits downstream |
| M3 | Package districts | Never wrap a single synthetic building: rooms are promoted into the district (entry dirs as gateways, structured dirs as buildings). Residual packages (partly claimed by compose services) instead yield a district per structured dir and district-less nodes for flat dirs |
| M4 | Assembly complete | Final sweep drops any edge whose endpoint was excluded by a later rule |

## Tuning constants

| Constant | Value | Rule |
|---|---|---|
| Dominant-segment expansion threshold | >60% of package files | S2 |
| Utility elimination | fan-in >= 3, instability <= 0.25 | C2 |
| Mid-coupling anchor | degree >= 5, 0.25 < instability < 0.8 | C2 |
| Host dedup coverage | >=50% shared services | D1 |
| OTLP edge confidence | 0.7 | M1 |
| Environment rank | prod 5, uat/staging 4, example 3, plain 2, dev 1 | D1 |
