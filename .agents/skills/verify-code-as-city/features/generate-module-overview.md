# Generate a module overview

Generate a module overview lets a user map a repository as modules instead of deployments: every file is a module, districts are directories or packages, bands run front to back, and only data-flow edges are drawn. It is the same command with `--overview`, and it writes `map.json` plus `map.md` only.

## Sub-features

- `overview-flag` generates the module overview with `--overview`.
- `overview-slim-output` writes only `map.json` and `map.md` (no deployment intermediates).
- `overview-valid` passes the Functionary validator like the deployment map does.

## How to get to it (user POV)

- Run `bun src/generate-map.ts <target-repo> --overview` in a terminal.
- Pick the `Module overview ⌘⇧↵` button in the viewer's Map a folder dialog (covered in map-a-folder; same output shape).

## Driving it with verify-city

Preconditions:

- Baseline preconditions from the map README hold.
- `scripts/doctor.sh` exits 0.
- `$SCRATCH/mini-ov` does not exist yet.

- **Overview run.** Generate over the bundled fixture. Run `./.agents/skills/verify-code-as-city/scripts/generate.sh --overview test/fixtures/mini-repo "$SCRATCH/mini-ov"`. stdout prints `Wrote …/mini-ov/map.json + map.md (overview mode)` with a `districts=… nodes=…` line, and the validator prints `Valid Functionary City map: Mini Repo overview (… nodes, … edges)` with exit 0.
- **Slim output.** Run `ls "$SCRATCH/mini-ov"`. Only `map.json` and `map.md` are present; none of the deployment intermediates exist.
- **Second view.** Re-validate read-only. Run `node vendor/functionary/validate-city-map.mjs "$SCRATCH/mini-ov/map.json"`. Exit 0 with matching counts.
- **Proof.** `$EVIDENCE/manifest.txt` carries a second block naming this feature ID and the `--overview` entry point, and `$EVIDENCE/map.json` is the overview map (its `name` ends in `overview`). Run `cat "$EVIDENCE/manifest.txt"`. Both blocks are present.

## Gotchas

- `--overview` and the default mode share inventory, structure, and import rules but apply different shaping groups (O versus D/C/R/M); a change that moves counts in one mode need not move the other.
- The default out-dir for an overview run is `out/<basename>-overview`; verification always passes an explicit `--out-dir` under `$SCRATCH` so the two modes never share a directory.
- Do not assert exact node counts across checkouts: counts are deterministic per repo content, and the fixture is the stable reference, not an arbitrary local repo.
