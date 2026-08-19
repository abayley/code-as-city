# code-as-city

Prototype answering one question: **how useful is a fully deterministic
(agent-free) generator for Functionary city maps?**

Throwaway code. No tests, minimal error handling, mechanical naming by design.

## Layout

- `src/generate-map.mjs` — the deterministic draft generator (no dependencies).
- `vendor/functionary/` — validator and schema copied from functionary.dev
  (MIT, licence included).
- `baseline/map.agent.json` — the agent-produced map of the functionary.dev
  repository, kept for comparison.
- `out/<repo>/` — generated output per target repository.

## Run

```bash
node src/generate-map.mjs ~/git/functionary.dev
node src/generate-map.mjs ~/git/aria-evals
node vendor/functionary/validate-city-map.mjs out/aria-evals/map.json
bun run dev   # local viewer at http://localhost:5173
```

## Viewer

`viewer/` is the upstream functionary.dev atlas (app/RepoCity.tsx + lib/*,
MIT) hosted as a plain Vite React app, with two local changes:

- **District-less nodes**: campus structures without a `parentId` render in an
  implicit "System" neighbourhood (upstream drops them). The change is the
  `isCampusNode` filter in `viewer/RepoCity.tsx`.
- `viewer/lib/local-showcases.ts` registers the generated maps in
  `out/` as showcases, so no file picker is needed.

## Outputs per run

- `map.json` — the city map.
- `deploy-shape.json` — hosts, services, images, Dockerfile bindings, cron
  schedules, wrangler config. The deployment-shape intermediate.
- `deps-files.json` — resolved file-level import edges.
- `deps-rooms.json` / `deps-rooms.dot` — room-level dependency graph
  (render the .dot with graphviz: `dot -Tsvg deps-rooms.dot > rooms.svg`).

## Heuristics (v2)

1. Inventory via `git ls-files` (respects .gitignore), excluding nested git
   repositories (vendored checkouts like `langfuse/`) and generated dirs.
2. Tests excluded: `test`/`tests`/`__tests__`/`coverage` dirs, `*.test.*`,
   `*.spec.*`.
3. **Deployment shape first.** Each docker-compose file is a host district
   (overlay files `*.override.yml`/`*.build.yml` skipped; environment variants
   deduped preferring prod > uat > example > plain > dev). Compose services
   become buildings; `COPY src/...` lines in each service's Dockerfile bind it
   to source rooms; ENTRYPOINT names the entry room; crontab lines
   (`compose run <svc>`) tag services as cron jobs; known images classify infra
   (postgres -> database, nginx -> gateway, ...).
4. `wrangler.*` produces a Cloudflare edge district with the worker and its
   bindings; `drizzle.config.*` contributes a database.
5. Source not claimed by any deployed service falls into per-package code
   districts, with rooms per directory (a dominant dir like `src/` is expanded
   one level), NodeNext-aware import resolution, and `@/` alias support.
6. Flow layers by longest path from entry rooms; every emitted edge is
   `declared` evidence.
7. **Coupling elimination** (v3/v4). Fan-in/fan-out/instability computed from
   the import graph (matches the archunitts numbers in
   `aria-evals/reports/source-quality.txt`). Rooms with fan-in >= 3 and
   instability <= 0.25 are shared lib-like leaves — unless they contain a
   significantly mid-coupled file (degree >= 5, instability 0.25-0.8, e.g. an
   annotation-store), which anchors the room. Eliminated modules reappear once
   per package as a single **Shared libraries** structure, with aggregated
   import-count edges from every campus node that uses them. Full metrics land
   in `coupling.json`.
8. **Residual promotion** (v4/v5). When compose services have claimed part of
   a package, the leftover rooms are promoted instead of being wrapped in a
   catch-all district: a dir with internal structure (two subdirs, or a subdir
   plus loose files) becomes its own district with a building (devstack,
   src/bootstrap, src/synthetic); a flat dir becomes a district-less campus
   node (plugins, src/conformance, examples). docs/ is excluded entirely.
8b. **Dev-tooling exclusion by reachability** (v6). Deployed roots (service
   image contents and entrypoints, wrangler main, package bin/main, web-app
   entry dirs) and package.json script roots are traced through the import
   graph. Script entries are split by naming convention: QA/codebase names
   (check, lint, test, adr, prepare, proof, uat, ...) versus operational names
   (bootstrap, certificates, backfill, ...). A file reachable only from QA
   scripts and imported by nothing that deploys is dev tooling, stripped at
   file granularity — so one operational CLI in scripts/ survives while the
   38 QA utilities around it vanish. Map warnings record every strip.
9. **OTLP producer heuristic** (v5). A promoted node whose source references
   `@opentelemetry/`, OTLP, or `OTEL_EXPORTER` gets an inferred `data_flow`
   edge (confidence 0.7) into the OTLP-receiving collector node, pulling data
   generators and agent plugins toward the ingress host they feed.
9b. **Package districts are always flat** (v7): the single synthetic package
   building is removed and its rooms promoted into the district. Entry dirs
   (app, bin) render as gateways. The web entry carries a `deploys` edge to
   the wrangler edge worker.
9c. **Orphan exclusion** (v7): areas imported by nothing, reachable from no
   deploy or script root, with no OTLP coupling and no entry role are dropped
   (examples/, unreferenced root config files).
9d. **Cross-package path references** (v7): a string literal resolving into
   another package's area (the CLI bundling `../../skills/map-codebase`,
   tried against both the file dir and the package root) reassigns that area
   to the referencing package's district with a declared `path reference`
   edge.
9e. **Fan-in-0 interior rooms** (v7): inside a promoted building, loose files
   nothing imports (CLIs, installers, command entries) each get their own
   room; imported support files stay grouped.
10. **Service wiring** (v3). `depends_on` is harvested across all compose
   variants by service name, so wiring declared only in the development
   projection still connects the deployed host's services. A dependency the
   surviving host does not run (the dev-only database container) is carried
   over as an infra node, classified by image or by name.

## Verdict so far (2026-08-19)

**functionary.dev** (16 nodes, 4 edges; agent baseline 31/29): correct
skeleton; Cloudflare edge now its own district matching the agent's "Edge
delivery". Still missing: semantic scope names, prose, `calls`/`data_flow`
edges, interpreted externals.

**aria-evals** (42 nodes, 31 edges): the
deterministic map arguably matches
the repository owner's mental model *better* than the agent map did. Districts
are the deployment hosts (Evaluation host, OTel collector gateway host, OTel
collector stack host) plus a leftover code district; the evaluation host holds
seven service buildings with cron/listens tags (span-ingest, scorer-dashboard,
trace-completion, delivery-worker, ...); the otlp-logs-bridge daemon appears as
a building on the stack host. All of it read from compose files, Dockerfiles,
and the crontab — because that repo declares its deployment shape explicitly.

Standing conclusion: when a repository declares its deployment shape,
determinism beats interpretation for district structure. The agent's remaining
edge is naming, prose, and repos with no declared shape.

Coupling elimination folds `src/lib`, `src/core`, and `src/providers` into one
Shared libraries building (`src/database` is anchored by the mid-coupled
annotation-store and stays a service room). Every service and tooling node
carries an aggregated import-count edge into the shared building, and the
services keep coordinator + database interiors.

Known rough edges: mechanical labels collide (three nodes labelled
"Functionary Dev"); the coupling thresholds (utility: fan-in >= 3,
instability <= 0.25; mid anchor: degree >= 5, instability 0.25-0.8) are
unvalidated beyond these two repos; promoted tooling nodes use the `worker`
archetype for want of a campus-level "plain code" archetype.
