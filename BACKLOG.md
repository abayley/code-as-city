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

## Known divergences preserved by RFC-0002 (latent bugs, per-mode options)

- Delivers inference (M10/O8): the overview path lacks the deployment's
  self-id and empty-file-set guards (inference.ts guardTargets: false).
- Database flow (M8/O8): the overview always targets the first database;
  the deployment prefers the district-local one.
- Entry classification (M3/O2) exists as three partial copies of one
  documented rule (overview isEntryModule; deployment childIsEntry and the
  entry-dir room check) with different arms.
- externalReferencePattern and sdkImportPattern interpolate names into
  regexes without escaping.
- Overview module fan-in/out is edge-counted over file sets and cannot be
  replaced by C1 fileCoupling (distinct-neighbour counts, self-edge
  handling, multi-file aggregation differ) — see the comment in
  assemble-overview.ts.

## Done since listed

- Viewer rotation around the vertical axis (MapControls enableRotate), with
  the polar angle locked so the ground plane never tilts.
- Module overview mode (`--overview`): districts per directory (per package in
  multi-package repos), every module a structure, height scaled by lines of
  code, shared-code districts coloured purple, zero edges. The viewer wraps
  edge-less district rows into a grid and honours district colours from the
  map. Height ∝ loc is a first slice of the stats-driven dimensions item.
