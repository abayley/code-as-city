# Generate a deployment map

Generate a deployment map lets a user turn any local repository into a Functionary city map from the terminal: districts are deployment hosts and packages, dev tooling and orphans are stripped, and the run emits `map.json`, `map.md`, and the deployment intermediates.

## Sub-features

- `deploy-default` generates the deployment map with no mode flags.
- `deploy-outdir` writes to an explicit `--out-dir` instead of `out/<basename>`.
- `deploy-intermediates` emits `deploy-shape.json`, `deps-files.json`, `deps-rooms.json`/`.dot`, `deps-rooms.md`, `coupling.json`, and `shared-libraries.md` when shared dirs exist.
- `deploy-modules-flag` honours `--modules-as-buildings` without breaking validation.
- `deploy-usage` prints `USAGE` and exits 2 when no target repo is given.

## How to get to it (user POV)

- Run `bun src/generate-map.ts <target-repo>` in a terminal.
- Run `bun src/generate-map.ts <target-repo> --out-dir <dir>` for an explicit output directory.
- Run `bun src/generate-map.ts` with no arguments to see usage.

## Driving it with verify-city

Preconditions:

- Baseline preconditions from the map README hold.
- `scripts/doctor.sh` exits 0.
- `$SCRATCH/mini` does not exist yet.

- **Default run.** Generate over the bundled fixture. Run `./.agents/skills/verify-code-as-city/scripts/generate.sh test/fixtures/mini-repo "$SCRATCH/mini"`. stdout starts with a `Wrote …` line naming `{map,deploy-shape,deps-files,deps-rooms,coupling}.json + deps-rooms.dot + {map,deps-rooms}.md`, followed by a `nodes=… edges=… hosts=…` line, and the validator prints `Valid Functionary City map: Mini Repo (… nodes, … edges)` with exit 0.
- **Explicit out-dir.** The run above already uses one: `$SCRATCH/mini/map.json`, `$SCRATCH/mini/map.md`, and the intermediates exist on disk. Run `ls "$SCRATCH/mini"`. All nine expected names are present.
- **Second view.** Re-validate the emitted map read-only. Run `node vendor/functionary/validate-city-map.mjs "$SCRATCH/mini/map.json"`. Exit 0 with the same node/edge counts as the drive step.
- **Usage error.** Run `bun src/generate-map.ts`. Exit code `2` and stderr prints the `Usage: generate-map.ts …` line.
- **Proof.** `generate.sh` has copied `$SCRATCH/mini/map.json` to `$EVIDENCE/map.json` and appended the manifest block to `$EVIDENCE/manifest.txt`. Run `ls "$EVIDENCE"`. `map.json`, `generator-stdout.txt`, `validator-stdout.txt`, and `manifest.txt` are present and name this feature ID and entry point.

## Gotchas

- The first `bun run test` matters: without the fixture's `coverage-summary.json` the coverage scan reads nothing and output silently differs from the goldens.
- `repository` in `map.json` is the absolute target path; golden comparisons normalise it to `<fixture>`, but a verification proof asserts validity and counts, not golden equality.
- Never point a verification run at `test/golden/` or `out/<showcase>`; the golden-regeneration commands in the README are the only sanctioned writes there.
- `shared-libraries.md` appears only when coupling eliminates shared dirs; its absence on repos without shared utility dirs is expected, not a failure.
