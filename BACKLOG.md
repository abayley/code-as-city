# Backlog

Ideas agreed in discussion, not yet built.

## Archetype shapes

Additional three.js geometries so module roles are visually distinct: leaf
utility modules as pyramids or ziggurats; today worker/storage/queue/room/
building all render as the same box (only database, cloud, gateway differ).
Change lives in geometryFor() in viewer/RepoCity.tsx.

## Stats-driven dimensions and coverage colouring

- Base area proportional to a complexity measure, height proportional to
  lines of code (the map schema already carries display.size and metrics.loc;
  the generator just never sets size).
- Code coverage as a vertical fill: a building with 60% coverage is coloured
  to 60% of its height, the remainder uncoloured. Needs a coverage source:
  scan for coverage/ or reports/ output (lcov.info, coverage-final.json,
  vitest/istanbul summaries) and map file coverage onto modules. aria-evals
  has coverage/ and reports/ folders to prototype against.

## Done since listed

- Viewer rotation around the vertical axis (MapControls enableRotate), with
  the polar angle locked so the ground plane never tilts.
- Module overview mode (`--overview`): districts per directory (per package in
  multi-package repos), every module a structure, height scaled by lines of
  code, shared-code districts coloured purple, zero edges. The viewer wraps
  edge-less district rows into a grid and honours district colours from the
  map. Height ∝ loc is a first slice of the stats-driven dimensions item.

- Wrangler `main` paths are resolved repo-relative only: a wrangler.toml in a
  subdirectory (packages/edge/wrangler.toml with main = "src/worker.ts") does
  not resolve its entry file, so the worker source is orphan-excluded instead
  of becoming a deploy root. Found while fixturing RFC-0001 Phase 0
  (2026-08-25).

- `findEdgeHost` reads the worker `name` only from JSON wrangler configs;
  a wrangler.toml name is ignored (regex fallback exists for `main` only),
  so TOML workers are labelled "Worker". Found while testing RFC-0001
  Phase 3 (2026-08-25).

- assemble-deployment quirks preserved during RFC-0001 extraction (2026-08-25):
  the service flowLayer ternary ends `service.dockerfile ? 1 : 1` (both arms
  1); 7a-ii can interpolate "image undefined" into a backing-service
  description when a variant service has no image; the drizzle-edge condition
  keeps a redundant nodes.some() arm.
