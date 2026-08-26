# Backlog

Ideas agreed in discussion, not yet built.

## Archetype shapes: storage and queue

Mostly built (see Done since listed). What still renders as a plain box is
`storage` and `queue`, which read identically to an ordinary worker or room.
Both deserve their own silhouette — a squat drum or stack for storage, a
segmented pipe or conveyor for a queue.

Shapes live in two places in viewer/RepoCity.tsx: `geometryFor()` for the
solid non-box bodies (cylinder, dodecahedron), and the `segments` memo for
everything built from stacked boxes (ziggurat, archway, clock tower, plain
box). A new box-family shape belongs in the latter, so the coverage-gap split
keeps working on it.

## Mode differences by design (recorded, not bugs)

- Overview module fan-in/out is edge-counted over file sets and cannot be
  replaced by C1 fileCoupling (distinct-neighbour counts, self-edge
  handling, multi-file aggregation differ) — see the comment in
  assemble-overview.ts.
- Entry classification's name arms differ per documented granularity (O2
  modules vs M3 residual children); both run through inference.ts
  isEntryPoint, where the arms are explicit options. The room-level
  entry-directory test in assemble-deployment.ts is deliberately NOT one of
  them: it chooses a room's archetype (gateway vs worker) from the directory
  name alone, where isEntryPoint also treats a script-referenced file as an
  entry, which would change archetypes. Recorded during REVIEW-0001, which
  found it described as an unclosed third copy.
- Database targeting (M8/O8) prefers a district-local database and falls back
  to the first. The district-local arm only ever selects in the deployment
  map: overview modules sit in directory districts while infra sits in host
  districts, so the two district spaces never intersect and the overview
  always targets one database. The shared strategy is genuinely shared; its
  preference is simply inert in one mode. If per-host database targeting is
  wanted in the overview, the module `host:<name>` tags are the route, and it
  is a behaviour change needing its own RFC.

## Sidebar/map colour tie-in (dropped by RFC-0003 Phase 4b)

Sidebar sections used to carry a left stripe in their district's colour,
tying each section to its district on the map. It was an inline per-district
hex, which the stock-components-only constraint forbids, so it was dropped
and the palette's per-district accent list removed (it was called
NEIGHBORHOOD_ACCENTS, before the viewer settled on "district"). If the tie-in
is wanted back, the options are a stock Badge per section carrying the colour
as data, or an explicit exception to the constraint for data-driven (not
decorative) colour.

## Done since listed

- Viewer rotation around the vertical axis (MapControls enableRotate), with
  the polar angle locked so the ground plane never tilts.
- Module overview mode (`--overview`): districts per directory (per package in
  multi-package repos), every module a structure, height scaled by lines of
  code, shared-code districts coloured purple, zero edges. The viewer wraps
  edge-less district rows into a grid and honours district colours from the
  map.
- Stats-driven dimensions: both assemblers now set `display.size` — base area
  from the O5/M11 footprint formula over worst-function complexity, height
  from lines of code.
- Archetype shapes, most of them: overview support modules render as
  four-sided ziggurats (the "leaf utility modules as pyramids or ziggurats"
  idea), gateways as archways, cron-tagged structures as clock towers,
  databases as cylinders and clouds as dodecahedra. Only storage and queue
  are still plain boxes.
- Coverage colouring: `scans.ts` reads Istanbul `coverage-summary.json` under
  coverage/ dirs and nodes carry `metrics.coverage`; the viewer splits a
  building's stacked segments at that height. The covered lower part keeps the
  node's own colour and the uncovered top renders in `palette.COVERAGE_GAP`
  (a blue that reads against the function-area orange) — the reverse of the
  original sketch, which had the covered part coloured and the rest bare. The
  fraction is clamped to a 0.04 floor so a wholly uncovered building still
  shows its own colour at the base, and the split is skipped for interiors,
  expanded nodes, and shapes that are not segment-stacked.
- Viewer terminology: the layout groups were called neighbourhoods (upstream
  functionary naming) while the same thing was called a district everywhere
  else, including `districtLayer` in the same module. Unified on district;
  the rail and in-scene markers read D1, D2, ... The map's scope nodes stay
  `scope` in the layout code, which is what distinguishes them from the two
  synthetic districts (`__near:<scope>` satellite strips and `__system`).

## Known bugs

- Viewer hover card: the last table row (type / entry point) is clipped by
  the popup collision boundary. Pre-existing (confirmed against the
  pre-shadcn CSS during RFC-0003 Phase 5), not introduced by the migration.
