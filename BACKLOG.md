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

## Mode differences by design (recorded, not bugs)

- Overview module fan-in/out is edge-counted over file sets and cannot be
  replaced by C1 fileCoupling (distinct-neighbour counts, self-edge
  handling, multi-file aggregation differ) — see the comment in
  assemble-overview.ts.
- Entry classification's name arms differ per documented granularity (O2
  modules vs M3 residual children); both run through inference.ts
  isEntryPoint, where the arms are explicit options.

## Sidebar/map colour tie-in (dropped by RFC-0003 Phase 4b)

Sidebar sections used to carry a left stripe in their district's colour,
tying each section to its district on the map. It was an inline per-district
hex, which the stock-components-only constraint forbids, so it was dropped
and palette.NEIGHBORHOOD_ACCENTS removed. If the tie-in is wanted back, the
options are a stock Badge per section carrying the colour as data, or an
explicit exception to the constraint for data-driven (not decorative) colour.

## Done since listed

- Viewer rotation around the vertical axis (MapControls enableRotate), with
  the polar angle locked so the ground plane never tilts.
- Module overview mode (`--overview`): districts per directory (per package in
  multi-package repos), every module a structure, height scaled by lines of
  code, shared-code districts coloured purple, zero edges. The viewer wraps
  edge-less district rows into a grid and honours district colours from the
  map. Height ∝ loc is a first slice of the stats-driven dimensions item.

- Viewer hover card: the last table row (type / entry point) is clipped by
  the popup collision boundary. Pre-existing (confirmed against the
  pre-shadcn CSS during RFC-0003 Phase 5), not introduced by the migration.
