# code-as-city

Prototype answering one question: **how useful is a fully deterministic
(agent-free) generator for Functionary city maps?**

Throwaway code. No tests, minimal error handling, mechanical naming by design.

Copied and tweaked the renderer from <https://github.com/nem035/functionary.dev>.

## Inspiration

- <https://x.com/fleetingbits/status/2088016749849682120>
- <https://functionary.dev/>
- <https://brcforecast.corbett.vc/system>

## Layout

- `HEURISTICS.md` — the catalogue of every rule the generator applies, with
  signals, actions, failure modes, and tuning constants.
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
node src/generate-map.mjs ~/git/aria-evals --overview --out-dir out/aria-evals-overview
node vendor/functionary/validate-city-map.mjs out/aria-evals/map.json
bun run dev   # local viewer at http://localhost:5173
```

## Two modes

- **Deployment map** (default): districts are deployment hosts and packages;
  dev tooling and orphans are stripped. Rules I/S/D/C/R/M.
- **Module overview** (`--overview`): every file is a module, districts are
  directories or packages, bands run front to back, only data-flow edges are
  drawn. Rules I/S plus the O group (see HEURISTICS.md, which explains what
  each mode shares and skips).

The viewer's "Map a folder" dialog offers the same choice as a checkbox.

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

## Heuristics

The full rule catalogue lives in [HEURISTICS.md](./HEURISTICS.md): inventory
(I1-I5), structure (S1-S4), deployment shape (D1-D13), coupling (C1-C3),
reachability (R1-R4), and map shaping (M1-M4), each with its signal, action,
known failure modes, and tuning constants. In one line: deployment manifests
define the districts, the import graph defines the edges and interiors,
coupling folds shared utility modules into per-package library structures, and
reachability separates operational tooling from QA scripts and orphans.

## Verdict so far (2026-08-19)

**functionary.dev** (17 nodes, 5 edges; agent baseline 31/29): correct
skeleton; Cloudflare edge now its own district matching the agent's "Edge
delivery". Still missing: semantic scope names, prose, `calls`/`data_flow`
edges, interpreted externals.

**aria-evals** (58 nodes, 33 edges): the
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
