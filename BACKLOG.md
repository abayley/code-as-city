# Backlog

Ideas agreed in discussion, not yet built.

## Module overview mode

A whole-codebase overview with every module as a building, grouped by
directory into districts (src/providers, src/lib, src/core each a district),
no dependency edges drawn. Districts that contain mostly or entirely leaf
modules (high fan-in, low fan-out) get a distinct colour, so shared-code
districts read differently from app-function districts. Probably a generator
mode (extending --modules-as-buildings) plus a viewer edge toggle.

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

- Viewer rotation around the vertical axis (MapControls enableRotate).
