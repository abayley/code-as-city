# code-as-city

Started as a prototype answering one question: **how useful is a fully
deterministic (agent-free) generator for Functionary city maps?** Graduated
to a maintained project in August 2026 (RFC-0001 to RFC-0003 under
`docs/rfcs/`). Working conventions for contributors and agents are in
[AGENTS.md](./AGENTS.md).

Copied and tweaked the renderer from <https://github.com/nem035/functionary.dev>.

## Quality checks

```bash
bun run check       # typecheck + lint + knip + tests
bun run typecheck   # tsc --noEmit (strict)
bun run lint        # biome, failing on any diagnostic (see below)
bun run format      # biome format --write .
bun run knip        # unused files/exports/dependencies
bun run test        # vitest (golden-master tests over test/fixtures/mini-repo)
```

`bun run lint` goes through `scripts/biome-clean.ts` rather than calling
`biome check .` directly. Biome exits zero on info-level diagnostics, and
`--error-on-warnings` only promotes warnings, so neither alone keeps the repo
biome-clean. The wrapper runs the same check twice — once for Biome's own
output, once as JSON — and fails if the report carries any diagnostic at all.

The golden-master tests in `test/generate-map.test.ts` run the generator over
the committed fixture repo `test/fixtures/mini-repo`, validate the output with
the vendored functionary validator, and compare against the golden maps in
`test/golden/` (ignoring `generatedAt`, and with `repository` normalised to
`<fixture>` so the goldens match in any clone). If a generator change
intentionally alters output, regenerate the goldens. Run the tests once first:
they write the fixture's gitignored coverage/coverage-summary.json (Istanbul
keys are absolute paths, so it cannot be committed), which the coverage scan
reads.

```bash
bun run test
bun src/generate-map.ts test/fixtures/mini-repo --out-dir /tmp/mini-dep && jq 'del(.generatedAt) | .repository = "<fixture>"' /tmp/mini-dep/map.json > test/golden/mini-repo-deployment.json
bun src/generate-map.ts test/fixtures/mini-repo --overview --out-dir /tmp/mini-ov && jq 'del(.generatedAt) | .repository = "<fixture>"' /tmp/mini-ov/map.json > test/golden/mini-repo-overview.json
```

Knip ignores `viewer/components/ui/`: those files are shadcn CLI output, not
hand-edited, and their export surface is fixed by the generator.

## Inspiration

- <https://x.com/fleetingbits/status/2088016749849682120>
- <https://functionary.dev/>
- <https://brcforecast.corbett.vc/system>

## Layout

- `HEURISTICS.md` — the catalogue of every rule the generator applies, with
  signals, actions, failure modes, and tuning constants.
- `BACKLOG.md` — ideas agreed but not built, mode differences that are by
  design, and known bugs.
- `src/generate-map.ts` + `src/lib/` — the deterministic generator, one module
  per heuristic group.
- `viewer/` — the three.js viewer (see Viewer below).
- `test/` — the golden-master test over `test/fixtures/mini-repo`, plus unit
  tests under `test/unit/` mirroring `src/lib/` and `viewer/`.
- `docs/rfcs/`, `docs/reviews/`, `docs/heuristic-changes.md` — plans,
  reviews, and candidate rule changes (conventions in `AGENTS.md`).
- `scripts/biome-clean.ts` — the lint wrapper described above.
- `vendor/functionary/` — validator and schema copied from functionary.dev
  (MIT, licence included).
- Local only, gitignored, absent from a fresh clone: `out/<repo>/` (generated
  output per target repository), `baseline/map.agent.json` (an agent-produced
  map of functionary.dev kept for comparison), `coverage/`, `dist/`.

## Run

Requires Bun. A fresh clone needs `bun install`, and one `bun run test` first
(it writes the fixture's gitignored coverage/coverage-summary.json, which the
coverage scan reads).

`viewer/lib/local-showcases.ts` statically imports seven maps from gitignored
`out/`. Until they exist, `bun run typecheck`, `bun run dev`, and `bun run
build` fail with TS2307 on that file. Remove the imports and the matching
`localShowcases` entries you do not have, or generate the maps first:

```bash
bun src/generate-map.ts ~/git/functionary.dev
bun src/generate-map.ts ~/git/aria-evals
bun src/generate-map.ts ~/git/aria-evals --overview --out-dir out/aria-evals-overview
node vendor/functionary/validate-city-map.mjs out/aria-evals/map.json
bun run dev   # local viewer at http://localhost:5173
```

Try the generator against the bundled fixture, no external repo needed:

```bash
bun src/generate-map.ts test/fixtures/mini-repo --out-dir out/mini
```

## Two modes

- **Deployment map** (default): districts are deployment hosts and packages;
  dev tooling and orphans are stripped. Rule groups I, S, D, C, R and M.
- **Module overview** (`--overview`): every file is a module, districts are
  directories or packages, bands run front to back, only data-flow edges are
  drawn. Rules I/S plus the O group (see HEURISTICS.md, which explains what
  each mode shares and skips).

The viewer's "Map a folder" dialog offers the same choice as two buttons
(`viewer/components/folder-browser.tsx`): **Deployment map** (⌘↵) and
**Module overview** (⌘⇧↵). The dialog's server-side API (`/api/browse`,
`/api/generate`) lives in `vite.config.mjs`; it is dev-server-only, runs Bun,
and must not be exposed on a network interface.

## Viewer

`viewer/` began as the upstream functionary.dev atlas (MIT) hosted as a plain
Vite React app and has since diverged. The UI chrome was rebuilt on stock
shadcn components (RFC-0003), and the pure logic was extracted from
`RepoCity.tsx` into `viewer/lib/` (navigation machine, campus projection, flow
layout, sizing), each with unit tests under `test/unit/viewer/`.
`RepoCity.tsx` keeps the react-three-fiber scene and wires the chrome together.
Notable behaviours relative to upstream:

- **District-less nodes**: campus structures without a `parentId` render in an
  implicit "System" district (upstream drops them). See `isCampusNode` in
  `viewer/lib/projection.ts`.
- `viewer/lib/local-showcases.ts` statically imports seven generated maps from
  `out/` as showcases (aria-evals, aria-tools, functionary.dev, nzlaw, and the
  overview variants it lists), so no file picker is needed. Because `out/` is
  gitignored, a fresh clone fails `bun run typecheck`, `bun run dev`, and
  `bun run build` with TS2307 on that file until those maps are generated or
  the imports and showcase entries are trimmed to what exists.
- `viewer/components/ui/` is shadcn CLI output, regenerated with the CLI rather
  than hand-edited.
- The "Map a folder" dialog is `viewer/components/folder-browser.tsx`.

## Outputs per run

Both modes write `map.json` (the city map) and `map.md` (a mermaid rendering
of it). The deployment map additionally writes the intermediates:

- `deploy-shape.json` — hosts, services, images, Dockerfile bindings, cron
  schedules, wrangler config. The deployment-shape intermediate.
- `deps-files.json` — resolved file-level import edges.
- `deps-rooms.json` / `deps-rooms.dot` — room-level dependency graph
  (render the .dot with graphviz: `dot -Tsvg deps-rooms.dot > rooms.svg`).
- `deps-rooms.md` — the room-level graph as mermaid.
- `coupling.json` — thresholds, eliminated shared rooms, and room- and
  file-level coupling, ranked.
- `shared-libraries.md` — interior breakdown of eliminated shared dirs, only
  when any exist.

## Heuristics

The full rule catalogue lives in [HEURISTICS.md](./HEURISTICS.md): inventory
(I1-I5), structure (S1-S4), deployment shape (D1-D17), coupling (C1-C4),
reachability (R1-R5), map shaping (M1-M13), and overview mode (O1-O11), each
with its signal, action, known failure modes, and tuning constants. In one
line: deployment manifests
define the districts, the import graph defines the edges and interiors,
coupling folds shared utility modules into per-package library structures, and
reachability separates operational tooling from QA scripts and orphans.

## Prototype verdict (2026-08-19)

Recorded when the prototype graduated and kept as the reason the project
exists. It predates D14-D17 and the HC-001 to HC-016 changes in
`docs/heuristic-changes.md` (label collisions, for one, have since been
fixed), so the node and edge counts below are historical. Current behaviour is
what `HEURISTICS.md` describes.

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
