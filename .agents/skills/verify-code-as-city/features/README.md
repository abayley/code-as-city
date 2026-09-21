# code-as-city verification map

This directory is the maintained source for verifying the user-facing behaviour of code-as-city. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Working directory is the repo root (`git rev-parse --show-toplevel`).
- `bun install` has been run; one `bun run test` has written
  `test/fixtures/mini-repo/coverage/coverage-summary.json`.
- `RUN_ID`, `SCRATCH`, and `EVIDENCE` are exported per the skill's Launch section.
- The seven `out/<showcase>/map.json` files exist (doctor checks this).
- The viewer dev server, when needed, is yours on port 5199 with `$SCRATCH/dev.pid`.
- Never drive an instance that was not started by this verification run.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer stable handles (CLI flags, route paths, button labels, aria-labels) over coordinates and tab order.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run generator drives through `scripts/generate.sh`; run API drives through `curl` exactly as shown.
- Run `scripts/doctor.sh` first whenever anything looks off.
- Restore nothing in the repo after a mutation: verification writes only under `$SCRATCH`, `$EVIDENCE`, and (for the API path) `out/<basename>`, which is gitignored. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Generator proof includes the `Wrote …` line, the validator verdict, and the emitted `map.json` copy.
- API proof includes the request body, the response (`jsonPath`), and a fresh validator run over the returned map.
- Browser proof includes an aria snapshot (or DOM text) and a screenshot with the app identity visible, plus a read-only second view of any side effect (the generated `map.json` re-validated).
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behaviour. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behaviour.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-city` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Generate a deployment map](./generate-deployment-map.md) covers the default CLI run: hosts and packages as districts, intermediates, and validator proof.
- [Generate a module overview](./generate-module-overview.md) covers `--overview`: every file a module, directory districts, data-flow edges only.
- [Browse a showcase](./browse-showcase.md) covers opening a bundled map in the viewer: empty shell cards, topbar picker, 3D city on screen.
- [Map a folder](./map-a-folder.md) covers the viewer dialog and its dev API: browse to a repo, generate either mode, load the result.
