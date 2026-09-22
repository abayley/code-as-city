# Heuristics catalogue

Every rule the deterministic generator applies, with its signal, action, and
known failure modes. Rules are grouped and numbered by stage; the IDs are
stable, so map warnings and commit messages can cite them.

Each group lives in a module under `src/lib/`, orchestrated by
`src/generate-map.ts`: I in `inventory.ts`; S in `packages.ts`, `rooms.ts`,
and `imports.ts`; C in `coupling.ts`; D in `compose.ts`, `dockerfile.ts`,
`crontab.ts`, `wrangler.ts`, `workflows.ts`, `hosts.ts`, `daemons.ts` (D15),
`runnable.ts` (D16), and `host-config.ts` (with D14's published-artefact
classification in `packages.ts`);
R in `reachability.ts` and `path-references.ts`; M in
`assemble-deployment.ts`; O in `assemble-overview.ts` (with `complexity.ts`
for O6); the coverage/TSDoc/embedded-database/external-service scans (D13, D17)
in `scans.ts`; output in
`emit.ts`. Rules documented as shared between the modes (M1/M8/M10 with O8,
D13 with O11, and the M3/O2 entry classification) are implemented once in
`inference.ts` with per-mode options; the delivers guards apply in both modes.
Database targeting prefers a district-local database and falls back to the
first, which only ever selects in the deployment map: overview modules sit in
directory districts while infra sits in host districts, so the overview always
targets one database. `map-types.ts` and
`assembly-helpers.ts` hold the shared vocabulary and helpers; `emit.ts`
builds the map envelope and applies M4 for both modes.

## Inventory (I)

| ID | Signal | Action |
| --- | --- | --- |
| I1 | `.git` present | Inventory via `git ls-files` (respects .gitignore); fall back to a directory walk |
| I2 | A directory contains its own `.git` | Excluded entirely (vendored third-party checkout, e.g. a langfuse clone) |
| I3 | Directory name in the ignore set (`node_modules`, `dist`, `generated`, `docs`, `examples`, `data`, ...) | Excluded entirely (a `data/` dir can hide fixture workspaces with their own package.json, which would flip the repo to multi-package and collapse O1's districts). HC-022: a content dir (`docs`/`examples`/`data`) carrying its own package.json is a workspace member package — a deployed Next.js site, not prose — and yields: its files stay inventoried. Build-output and dependency dirs never yield (bundlers write package.json into `dist/`) |
| I4 | Path segment in `test`/`tests`/`__tests__`/`coverage`/`test-database`, or filename matching `*.test.*`, `*.spec.*`, `*_test.*` (in `.py` files also `test_*.py` and `conftest.py`, HC-026) | Excluded from source analysis |
| I5 | Filename matching `*.config.{ts,js,mjs,cjs}`, `*-setup.*`, or `.*rc.js` | Tool configuration pretending to be code: excluded from source analysis (still visible to config-driven rules such as D7) |

Failure modes: I3 excludes `docs/` even when it contains real code (accepted
by decision); I2 depends on the nested checkout retaining its `.git`.

## Structure (S)

| ID | Signal | Action |
| --- | --- | --- |
| S1 | `package.json`, or a Python marker (`pyproject.toml`/`uv.lock`/`requirements.txt`) | A package. `bin` -> CLI; react/next/vinext/vue/svelte dep -> web app; otherwise generic. A directory with a Python marker and no `package.json` is a Python package (HC-026: name from pyproject `[project] name`, else the directory basename; no published artefact) — a non-Node service gets a package container, so its rooms form from the layout. A workspace-root aggregator with no source of its own (only `workspaces`/`private`) contributes no district: districts are keyed off packages that own active rooms, so a source-less root package produces no node in either view |
| S2 | First path segment within a package | A room. A dominant segment holding >60% of files (e.g. `src/`) is expanded one level (`src/ingest`, `src/lib`, ...) |
| S3 | Import specifiers | Resolved relative paths, `@/` alias to package root, NodeNext `./x.js` -> `x.ts`, bare specifiers matching sibling package names |
| S4 | A loose file with file-level fan-in 0 inside a promoted building | Its own room, named after the file (a CLI, an installer); imported loose files group as a support-files room. Kebab-flattened id collisions (the file src/node.ts vs the room src/node/) get a numeric suffix |

Failure modes: S3 does not read tsconfig `paths` beyond `@/*`; S2's 60%
threshold is untuned beyond the test repos.

## Deployment shape (D)

| ID | Signal | Action |
| --- | --- | --- |
| D1 | `docker-compose*.yml` | One host district per compose file. Overlays (`*.override.yml`, `*.build.yml`) skipped; test-directory composes are not topologies (I4: under `test`/`tests`/`__tests__` or a `*.test.*` filename). A `Dockerfile` no compose service builds is a single-service host of its own (HC-018: the image a user pulls and runs directly — `Dockerfile` in any case with a `-`/`.`/`_` qualifier that is not a source extension (`dockerfile.ts` is code, not a variant), name from the repo basename with an `image` qualifier, one `app` service, entry from ENTRYPOINT/CMD per D3, no D5 classification; a dev/test/local filename qualifier tags the service `dev-environment`, and a Dockerfile under a test path is a fixture, not a host). Environment variants deduped when a higher-ranked host covers >=50% of a host's services; rank prod > uat/staging > example > unqualified > dev. Coverage (HC-020) counts a service only when its IMAGE matches too — alternative services reusing a name (supabase's kong/envoy/caddy `api-gw`) are distinct topologies, not variants, and each is tagged `alternative` — while a dev-ranked variant keeps the name-only coverage (its builds replace the canonical images wholesale). Beyond dedup, a service recurring across the surviving topology files in a directory folds to one owner node — the canonical unqualified file (`docker-compose.yml`, `compose.yaml`) if one defines it, else the highest env rank, else the lowest filename; ownership keys on name+image, so a same-named service shipping a different image is never shadowed, and a host left with no node of its own is dropped. Applies in both map modes |
| D2 | Compose file path | Host name from informative path segments (generic segments like `deploy` dropped); a root or all-generic path yields none, so the name falls back to the repo basename rather than the placeholder "host" |
| D3 | Service `build.dockerfile`, or `images/<service>.Dockerfile` convention | Service bound to its Dockerfile; the `build.context` participates: a `dockerfile` unresolvable at the repo root resolves against the context (compose-relative, HC-017's immich `../machine-learning` case), and a build block naming only a context defaults to that context's own `Dockerfile` (HC-017's excalidraw `context: .` case); when the context is not the repo root, COPY sources and entry tokens that match nowhere at the root resolve against it. `COPY src/...` lines become the service building's rooms (a leading `./` on a COPY source is normalised to the repo-relative path, and a COPY that names a file with no source under it — a layer-cache `COPY ./pkg/package.json` — attributes nothing); the entry room is named by the first token across all ENTRYPOINT/CMD lines (in file order) that matches an inventoried file, so the split `ENTRYPOINT` interpreter plus `CMD` script form and multi-stage builds both resolve. A `*-command` entry file names the building (Delivery Command, not the compose service name delivery-worker). Service `ports:` values are kept for D19/D20 endpoint matching || D4 | Crontab line running `compose run <service>` | Service tagged `cron` (scheduled job), schedule recorded |
| D5 | Container image name, else service name (`database`, `redis`, `proxy`, ...) | Infra classification: database/queue/storage/gateway/cloud. A service is a database only on an exact base image name (`postgres`, `mysql`, `clickhouse-server`, ...; tag and registry/org stripped) or a store-like service name — never on a substring, so `postgrest/postgrest` and `supabase/postgres-meta` stay non-databases. Queue/storage/gateway/cloud remain vendor-family substring matches |
| D6 | `depends_on`, harvested across ALL compose variants by service name | `depends_on` edges between the surviving host's services. A dependency only present in a deduped variant (dev-only database container) is carried onto the host as an infra node |
| D7 | `wrangler.toml/json/jsonc` (HC-024: not one under a `*template*` directory — a config copied into user projects deploys nothing from this repo) | A Cloudflare edge district with the worker and its D1 bindings; `drizzle.config.*` contributes a database node. The worker name comes from `name` (defaulting to `worker`) and its entry from `main`; in TOML both keys are read line-anchored, so `database_name` in a `[[d1_databases]]` block is not mistaken for the worker name. `main` resolves repo-relative first, then against the config file's own directory |
| D8 | Wrangler present and the owning package has an entry dir (`app`, ...) | `deploys` edge from the entry room to the edge worker |
| D9 | `.github/workflows/*.yml` whose run step invokes deploy-reachable source (the workflow IS the deployment mechanism) | A CI job district with one job building; cron carried as a tag; `workflow_run` upstreams become declared `calls` edges ("triggers on completion") between deploying jobs. Routine workflows (lint, release, dependency bumps, bots) are development infrastructure, not the running system, and are excluded from the deployment view — a workflow qualifies only when at least one run-step invocation resolves to deploy-reachable source. CI never appears in the overview, so this is deployment-view-only |
| D10 | A run-step token naming an existing source file (optionally followed by a subcommand word) | Declared `calls` edge job -> entry's node; the subcommand is matched against the entry's Commander `.command('<sub>')` registration and the first imported identifier used in that chunk resolves the handler module for a second `calls` edge |
| D11 | `aws s3 cp/sync/mv` with an `s3://` source or destination; `r2.cloudflarestorage.com` anywhere in the workflow names the store | One external storage node ("Cloudflare R2", else "S3 object storage"); declared `data_flow` edges: store -> job for downloads, job -> store for uploads |
| D12 | An https URL assigned as a value (not a comment) in a package-root `config.yaml` | External cloud node per hostname (localhost and R2 endpoints excluded); declared `data_flow` "fetches" edge external -> the package's bin entry node (bin target mapped dist/x.js -> src/x.ts). Open (HC-019): whether a hardcoded https URL constant in deploy-reachable source (ollama-code's clearcut telemetry endpoint) is a D12-class signal |
| D13 | A package.json dependency naming an embedded database SDK (`@lancedb/*`, `chromadb`, `better-sqlite3`/`sqlite3`, `duckdb`, `embedded-postgres`) | One database node per dependency repo-wide, applied in BOTH map modes: in the deployment map it sits in the district of the first module importing the SDK; importers get inferred `reads/writes` data flow (confidence 0.7). Overview mode's O11 shares this scan |
| D14 | A non-private `package.json` declaring `bin` (CLI), `engines.vscode`/`contributes` (VS Code extension), or a `main`/`module`/`exports` entry with a name (published library) | A published deployment artefact: one deployable per package. The artefact's source entry (the `bin` target or library/extension entry, resolved via the `./`-normalised dist->src and `.m/cjs`->`.ts` conventions, the `types`/`typings` d.ts mapped to source, package-name-derived `src/<name>.ts`, then `src/index.ts`/`index.ts`/`src/main.ts` — HC-027) becomes a deploy root (so a bundled library is not swept as an R3 orphan) and its owning node becomes the deployable — a CLI or extension reads as a `gateway`, a library as a `building` (a `gateway` when it has fewer than two rooms) — tagged `cli`/`published`/`extension`. A workspace library whose files land in a host image (HC-021: a claimed directory owned by the package, or a claimed file of the package under a coarse parent COPY) is a component of that deployment, not an artefact of its own: its node keeps a `bundled` tag instead of a deployable marking. R5 never strips a published artefact |
| D15 | A `spawn`/`spawnSync`/`fork`/`execFile[Sync]`/`Bun.spawn` or `new Worker(...)` call in deploy-reachable (non-test) source whose first path argument is a literal (bare, or inside a `new URL('<path>', import.meta.url)`) resolving to an inventoried entry (with the dist->src / `.m/cjs`->`.ts` conventions) | The target is a daemon the caller starts: a `deployable`/`worker` process node tagged `daemon`, with a `calls` edge labelled "starts" (evidence inferred, confidence 0.7) from the supervisor's node. A spawn on a variable or an external command resolves to nothing and draws no edge. Deliberately conservative — it never invents an edge it cannot ground in a real file, so it stays silent on repos that spawn through variables |
| D16 | An app run directly, with no compose/wrangler/published-package declaration: a web-role package with a root SPA entry (`index.tsx`/`main.tsx`/`App.tsx`, at the package root or under `src/`), a package whose `start`/`serve` script targets source that starts a server (`Bun.serve`/`.listen`/`createServer`/fastify/express), or — HC-022 — a package whose `start`/`serve`/`dev` script runs an app framework (`next`/`nuxt`/`astro`/`svelte-kit` start/dev/preview), anchored to the router dir's first inventoried file (`app/`, `pages/`, `src/app/`, `src/pages/`) | A runnable-app deployable: the entry's owning node becomes a `gateway`, tagged `app` (web SPA) or `server`. The entry seeds a deploy root (so R3 does not orphan it) but is NOT a host deploy root — independent runnable apps are separate deployments, so one must not make the repo host-shaped and strip the others; R5 spares runnable packages directly. Takes precedence over D14's library classification (a runnable app that also declares `main` shows as the app, not a library) |
| D17 | A package.json dependency naming a known service client SDK (`imapflow`/`node-imap` mail, `nodemailer` SMTP, `openai`/`@anthropic-ai/sdk`/`@google/generative-ai`/`ollama`/... LLM APIs, `stripe`, `twilio`, `firebase`, `socket.io-client`, `@sentry/*`, ...) | An external cloud node per distinct service (several SDKs fold to one), applied in BOTH map modes, with an inferred `data_flow` "uses" edge (confidence 0.7) from every module whose source imports the SDK. An endpoint-override step then resolves the SDK's base URL through its env fallbacks (HC-019): an importer of an SDK the override names (the `openai` SDK routes by base URL) referencing the env var (`OLLAMA_BASE_URL`) resolves the service to that backend — several services resolving to the same backend fold to one node with unioned importers. Drawn only when a deployed module actually imports it, so a bare dependency draws nothing. Deliberately precise — offline siblings (`@anthropic-ai/tokenizer`, `mailparser`) are not clients and are not matched |
| D18 | A `vercel.json` or `netlify.toml` outside test paths and template dirs (HC-025's first slice) | A platform site deployment, in the deployment map only: one site district per config with a `gateway` deployable tagged `site` and by platform, carrying the build command and publish/output dir as attributes. The owning package's code ships with the site, so its files seed deploy roots (R3 keeps them) without becoming host roots, and R5 spares site packages directly; the owner's entry (the runnable entry, else an emitted entry-dir room) carries a declared `deploys` edge to the site, mirroring the wrangler edge |
| D19 | A static `http(s)` URL passed to any call, set on an SDK/client-config property (`baseURL`, `endpoint`, ...), or read from the environment in deploy-reachable source (HC-023) | A declared `data_flow` edge labelled `http` from the caller's node to the sibling service, when the target's hostname matches exactly one declared service name (a declared port corroborates same-named alternatives; the caller's same-host sibling wins) or its loopback port matches exactly one declared container port. An env var resolves through the `environment:` entries of the services copying the file in, their `env_file:` dotenv files, and the repo-root `.env` (service entries win; `${}` interpolates one pass) — conflicting values stay silent, as do shell pass-throughs no file defines. Comments are stripped before matching; template literals never count as static; anything ambiguous draws nothing |
| D20 | `host:port` tokens in a `prometheus.yml`/`prometheus.yaml` `scrape_configs:` block outside test paths and template dirs (HC-023) | A declared `data_flow` edge labelled `scrapes` from the prometheus service to the scraped service, resolved as D19 (name, port-corroborated). Drawn only when a prometheus service is itself declared; otherwise nothing |
| D21 | A served static-asset dir (`express.static("<dir>")`, FastAPI/Starlette `StaticFiles(directory="<dir>")`) in deploy-reachable source (HC-023) | A declared `data_flow` edge labelled `serves` from the server's node to the owning package's runnable entry — the served dir is usually build output and never inventoried, so the edge targets the app, not the dir |
| D22 | An ECS task-definition file (`*task-definition.json` with container definitions) outside test paths (HC-025) | A platform host district per file: one service per container definition, with image classification, port mappings (kept as `host:container` for D19/D20 matching), and container dependencies joining the D6 harvest. Joins the candidate hosts, so variant dedup and name+image ownership folding treat it as a topology like any other — a file restating the compose shape folds away, platform-only services surface |
| D23 | A directory of quadlet `.container` units outside test paths (HC-025) | One platform host district per directory: the filename names the container, with `Image:`, `PublishPort:`, and `After`/`Requires`/`Wants` dependencies scoped to sibling containers (systemd targets never become dependencies). Joins the candidate hosts like D22 |

Failure modes: D1's rank list and 50% threshold are conventions; D19 reads
only literal env sources (interpolated compose values resolve through the
merged scope; key-only pass-throughs and service-dir `.env` files are not
read) and only `express.static` / `StaticFiles` serve forms (D21); D22 needs
a parseable task definition with a non-empty container list, D23 needs an
`Image:` to classify beyond the name (an imageless unit with a generic name
classifies as nothing); D14's
private-vs-published signal is `private: true` alone (publishConfig unused;
adequate across the sample); a bundled library that is genuinely published as
well as host-bundled (paperclip's adapters may be exactly that) reads as
`bundled`, not deployable — a release-evidence second gate is deferred
(HC-021); a bundled library whose source entry is neither the declared path nor a conventional entry gets no deployable (HC-027's chain
covers name-derived, types, and normalised entries; a package with no source
rooms at all still has no node to mark); D5's tables are small and vendor-biased; D7's
TOML reader does not track tables, so a `name` under `[env.staging]` is read
as though it were top-level; D10's handler match assumes Commander-style
registration in the entry file and only scans braced named imports; D12's
dist->src bin mapping is a convention. D17's endpoint-override table is
small and vendor-biased (one entry), and one SDK fronting several externals
(firebase's Firestore vs Storage) still folds to one node. Python package
dependencies (`huggingface-hub`/`transformers` in a pyproject) are not scanned,
so model-download flows draw nothing (HC-026 follow-up). D18 covers static
sites only (vercel.json, netlify.toml); ECS task definitions and quadlet units
are D22/D23 platform hosts instead.

## Coupling (C)

Computed from the import graph; matches archunitts fan-in/fan-out/instability
(instability = out / (in + out)).

| ID | Signal | Action |
| --- | --- | --- |
| C1 | All import edges | Per-file and per-room fan-in, fan-out, instability; written to `coupling.json` |
| C2 | Room fan-in >= 3 and instability <= 0.25, and NO file in the room is significantly mid-coupled (degree >= 5, 0.25 < instability < 0.8) | Room eliminated as a shared utility leaf. A mid-coupled file (e.g. an annotation-store) anchors its room against elimination |
| C3 | RETIRED | Eliminated rooms formerly reappeared as per-district "Shared libraries" copies; dropped by decision (repeated noise). Shared code is simply removed from the deployment map. Overview mode still shows every file. |
| C4 | Room (or service COPY, or building child) named `lib` | Excluded from the deployment map by decision: shared plumbing, not deployment shape. Residual "(files)"/"Support files" campus groupings likewise |

Failure modes: C2 thresholds validated only on aria-evals/functionary.dev/
aria-tools; C2 fires on self-contained tools whose lib serves one package
(accepted, given C3's parenting); the district-less C3 fallback requires the
patched viewer.

## Reachability (R)

| ID | Signal | Action |
| --- | --- | --- |
| R1 | Deploy roots: files COPY'd into service images, Dockerfile entrypoints, wrangler main, package bin/main, web entry dirs. Script roots: path tokens in package.json script commands. Script entries split by name: a QA keyword (`check`, `lint`, `test`, `coverage`, `inventory`, `adr`, `prepare`, `proof`, `uat`, ...) in ANY segment of the script name marks it QA (`tool:test:coverage` is QA despite its prefix); anything else is operational (`bootstrap`, `backfill`, `process-all`, ...) | Three reachability sets over the import graph: deploy, script, operational |
| R2 | File reachable only from QA scripts and from nothing that deploys | Dev tooling: stripped at FILE granularity (one operational CLI in `scripts/` survives while QA utilities around it vanish); a QA-stripped room also sheds its residue — files referenced by no root whose importers are all themselves stripped (iterated to a fixed point; OTLP producers exempt). Emptied rooms disappear. Every strip is recorded in map warnings |
| R3 | Room with zero fan-in, unreachable from deploy and script roots, no OTLP coupling, not an entry dir, not path-referenced | Orphan: excluded (examples/, unreferenced root config files) |
| R4 | A string literal resolving into another package's area (tried against both the file's dir and the package root, e.g. `resolve(packageRoot, "../../skills/map-codebase")`). Plain relative import specifiers are excluded — an import is an S3 dependency, not an area claim (a root QA script importing `../tools/x/src/core` must not steal the room) | The referenced area is reassigned to the referencing package's district, with a declared `path reference` edge |
| R5 | A package no *host* deploy root reaches (compose COPY/entry, wrangler main, web entry — not package bin/main), when the repo has a host deployment shape at all | Development-only package (e2e harness, dev-only plugin SDK): excluded from the DEPLOYMENT view only, as R2 strips dev-tooling files within a package. A residual (compose-claimed) or path-referenced package is spared, and the overview keeps every such package. Deployment-view-only; does not disturb R1/R2 |

Failure modes: R1's QA/operational split is a naming convention (a
mis-named script entry flips its targets); R3's OTLP exemption is the only
thing keeping unreferenced-but-meaningful producers (plugins/) on the map. R5
depends on D3 resolving the host's COPY sources: a Dockerfile whose COPYs the
parser cannot map to inventoried dirs leaves the repo with no host deploy shape,
so R5 does not fire there. When D3 does resolve a large deployed package (immich's
server, once its `./`-prefixed COPYs are read), that package is shown in full —
a scale concern tracked separately under HC-011, not R5.

## Map shaping (M)

| ID | Signal | Action |
| --- | --- | --- |
| M1 | A promoted node's source references `@opentelemetry/`, `otlp`, or `OTEL_EXPORTER` and a collector node exists | Inferred `data_flow` edge (confidence 0.7, "OTLP export") to the collector, preferring the gateway host's |
| M2 | Entry rooms (`bin`, `app`, `routes`, ...) and the room import graph | `flowLayer` by longest path from entries; infra sits downstream |
| M3 | Package districts | Never wrap a single synthetic building: rooms are promoted into the district (entry dirs as gateways, structured dirs as buildings). A bare `src/` room wraps nothing (HC-003): its children promote to the district and the room itself is not emitted, so the deployable marking lands on the entry room (Cli, not Src) — a barrel child takes its directory's name, as in the overview. A room expands into a building only over the children actually emitted — a `lib` child is shared plumbing and skipped, so a room holding nothing but `lib/` plus loose files stays a leaf rather than a single-room building (which the validator rejects). Every package — residual (partly claimed by compose services) or not — keeps ONE package district (HC-028): the claimed rooms filter out, and the leftover rooms and loose root files group under it, so nothing renders district-less. The district label is the artefact role when unique repo-wide (the one CLI package reads "CLI"), else the claiming host service's role when its name starts with the package's ("Immich Server" over the `immich` package reads "Server"), else the scope-stripped package name — never the directory name ("Src"). File-level children share the overview's entry classification: a script-referenced file or an entry-named loose file (redeploy-cli) is a `gateway`. (A coarse-COPY-to-host attribution rule was tried and reverted: baked-in-but-unreferenced tooling dirs do not belong on the host) |
| M9 | Host districts | Explicit `display.flowLayer` = 1000 + position in the declared forwarding chain (M5 scan: gateway before stack before evaluation), so hosts always sit behind the code districts and edge cycles (evaluation <-> bootstrap) cannot scramble their row order |
| M10 | A node's files reference an external by SDK import or env-var prefix | Inferred `data_flow` "delivers" edge (confidence 0.6) node -> external, in the deployment map as in overview O8. HC-024 precision: an entry whose files are ALL script-reachable (R1) delivers nothing; and a pair the D17 pass already drew (a `uses` edge) draws no second edge |
| M11 | Lines of code and per-function complexity of a deployment node's files | Height = 0.6 + log2(1 + loc/200) * 0.55 (log-scaled: services are multi-file aggregates running to 5 figures of loc); floor area = the O5 footprint formula (worst single function, clamped 0.95-2.5) |
| M12 | Istanbul `coverage-summary.json` under a `coverage/` dir at repo or package root (one suite subdir deep) | Suites merge by best per-file line coverage; nodes carry a line-weighted `coverage` metric (both map modes). The viewer renders every box-family shape (buildings, ziggurats, archways, clock towers) as stacked segments split at the covered height — covered fraction in the node colour, the remainder red. Databases and clouds carry the metric only |
| M13 | The first `/** */` block in a node's file that is file-level (nothing but comments before it) or attached to an export; in a `.py` file, the leading `"""` module docstring (HC-026) | Its first paragraph (tags dropped, capped at 280 chars) leads the node description ahead of the mechanical stats, in both map modes. Multi-file nodes prefer the declared entry file's doc (a service's Dockerfile entrypoint), else the best entry-named file |
| M4 | Assembly complete | Final sweep drops any edge whose endpoint was excluded by a later rule |
| M5 | Host config exporter endpoint/env lines matching another host's name or another host's service name (kebab~snake normalised, >=6 chars) | Declared `data_flow` between the hosts' primary services (gateway collector -> stack collector; stack collector -> span-ingest) |
| M6 | Exporter endpoint env token naming nothing internal (LANGFUSE_OTLP_ENDPOINT), with a +/-4-line window guard against internally-named blocks | Declared external cloud node with a `data_flow` edge from the exporting service. Externals (M6, D11, D12) share one "External systems" district behind the host chain — they are their own systems, not tenants of the host whose config mentions them |
| M7 | A campus node's files start a server (Bun.serve, .listen, createServer) or construct HTTP clients (fetch, axios) | Tags `listens` / `http-client` |
| M8 | A campus node's files contain SQL write forms (`insert into`, `delete from`, `update ... set`) or ORM write calls on a database-ish receiver (`db.insert(...)`); reads via `select ... from` / `db.select(`. HC-024: the module must be plausibly server-side — not every file `.tsx`/`.jsx` (browser components), and some file references a database client (SDK import or pool factory; a curated pattern) — or the match is a string literal, not a query | Inferred `data_flow` (confidence 0.75): writes flow node -> database, reads flow database -> node; target is the same-district database node, else the map's only one |

## Overview mode (O)

The generator has two modes. The default **deployment map** applies
inventory/structure (I, S), deployment shape (D), coupling (C), reachability
(R), and map shaping (M). `--overview` produces a whole-codebase **module
overview** instead: it shares I, S, and the C1 coupling metrics, reuses the
D/M scans for hosts, externals, and flow (see O7-O10), and applies R2
dev-tooling stripping (a `scripts/` directory reachable only from QA-named
package.json scripts vanishes here as in the deployment map), but skips
coupling elimination (C2/C3) and orphan exclusion (R3). Import
edges are emitted aggregated per module pair but the viewer draws them only
when a node is selected — at rest only data flow shows. The O rules below
apply only in this mode.

| ID | Signal | Action |
| --- | --- | --- |
| O1 | Single package | One district per top-level directory (S2 segmentation, so `src/` expands a level: src/lib, src/ingest, ...); multi-package repos get one district per package |
| O2 | Module granularity inside a district | Every file is its own module, wherever it sits in the tree and in multi-package repos too (subdirectories such as src/lib/configuration are shown as their files, disambiguated by subdirectory when names collide; kebab-flattened id collisions get a numeric suffix). Fan-in-0 modules are `composer` (front row); imported ones are `support` (row behind, 85% height, rendered as ziggurats; floor area is complexity alone, so equal complexity means equal footprint for both kinds). Archetype classification matches the deployment map: a module whose file is referenced from a package.json script command is a DECLARED `gateway` ("Entry point") whatever its name; a composer (fan-in 0) module under an entry dir (`bin`, `app`, `cli`, ...) or whose file basename is or ends in `cli`/`cmd`/`command`/`main` (redeploy-cli, delivery-command) also qualifies, but imported modules never do by name alone (a shared configured-command helper is plumbing). Other modules are `worker`, which the viewer leaves unlabelled. Within a district, modules place in path order (`display.flowOrder`) so files in the same directory sit adjacent |
| O3 | Files matching `**/migrations/<digits>[-_.]...` | Collapse to one leaf module per migrations directory ("Migrations (N)") |
| O4 | >=60% of a district's modules are utility (fan-in >= 2, instability <= 0.33) | District coloured as shared code (gold) instead of function area (terracotta). Independently, an all-`.tsx` module is coloured its own UI terracotta (distinct from both), and the viewer legend lists whichever structure colours the map uses |
| O5 | Lines of code and per-function cyclomatic complexity | Height = 0.55 + loc/320 (floor 0.6, loc capped at 1500); footprint = 0.85 + sqrt(complexity)/4 (clamped 0.95-2.5, the ceiling matching the viewer's layout step at render scale so buildings cannot overlap). Complexity is the module's WORST single function, not a sum: a big module of simple functions must not outscore one gnarly function |
| O6 | TypeScript compiler API available | McCabe complexity per function (1 + decision points attributed to the innermost enclosing function; logical operators and non-default `case` clauses count; top-level statements form an implicit function). Regex decision-point fallback otherwise (sum == max, no attribution) |
| O7 | Deployment shape | Per-host infrastructure districts: image-only services and backing stores (from ANY compose variant, attributed to the surviving host sharing services) sit in their host's district; env-token externals (M6 scan) get an "External systems" district |
| O8 | Flow edges | Declared collector chain from host-own configs (host-name and service-name matching as M5; a matched service resolves to the module owning its Dockerfile ENTRYPOINT); inferred OTLP producers -> gateway collector (M1 pattern); inferred database reads/writes (M8 patterns); inferred `delivers` edges from modules referencing an external by SDK import or env prefix |
| O9 | Deploy-host attribution | Files map to hosts via D3 COPY membership; a COPY coarser than room granularity (a dashboard image copying bare `src`) is ignored as packaging convenience. Modules carry `host:<name>` tags |
| O10 | Bands | Districts arrange front-to-back: Shared & support (multi-host or unplaced code), Generators (undeployed OTLP producers), the host chain ordered by declared forwarding, External systems. Emitted as scope `display.flowLayer` plus a `band:<label>` tag; a band shared by several hosts takes the canonical topology's name (a Dockerfile-only image host layers without renaming the band). The viewer renders band names as rail headers and honours explicit district layers over edge inference |
| O11 | The D13 embedded-database scan | Database node in an Infrastructure district; modules importing the SDK get an inferred `reads/writes` data-flow edge (confidence 0.7) |

Failure modes: O4's 60% cut is untuned (src/core and src/providers read as
function areas at file granularity); O6 attributes top-level statements'
branches to the file rather than a function; O9 depends on Dockerfiles
COPYing module-level dirs.

## Tuning constants

| Constant                             | Value                                                       | Rule |
| ------------------------------------ | ----------------------------------------------------------- | ---- |
| Dominant-segment expansion threshold | >60% of package files                                       | S2   |
| Utility elimination                  | fan-in >= 3, instability <= 0.25                            | C2   |
| Mid-coupling anchor                  | degree >= 5, 0.25 < instability < 0.8                       | C2   |
| Host dedup coverage                  | >=50% shared services                                       | D1   |
| OTLP edge confidence                 | 0.7                                                         | M1   |
| Environment rank                     | prod 5, uat/staging 4, example 3, plain 2, dev 1            | D1   |
| Overview shared-district cut         | >=60% utility modules (fan-in >= 2, inst <= 0.33)           | O4   |
| Overview height / footprint          | 0.55 + min(loc, 1500)/320; 0.85 + sqrt(max fn complexity)/4 | O5   |
