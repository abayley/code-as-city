# Map a folder

Map a folder lets a user point the viewer at a repository on the server machine and generate a city map without touching the terminal: the dialog browses server folders via `/api/browse`, generates via `/api/generate` with either the `Deployment map` (⌘↵) or `Module overview` (⌘⇧↵) button, validates the result, and loads it into the scene. The API is dev-server-only and must never be exposed on a network interface.

## Sub-features

- `folder-browse` lists server directories with a breadcrumb, a `git` badge on repositories, and a `../` parent row (`Parent folder` aria-label).
- `folder-generate-deploy` produces and loads a deployment map for the current folder.
- `folder-generate-overview` produces and loads a module overview for the current folder.
- `folder-error` surfaces browse or generate failures inline as a `Could not map that folder` alert.

## How to get to it (user POV)

- Choose the `Map a folder` button on the empty shell or in the topbar.
- Press ⌘↵ (deployment map) or ⌘⇧↵ (module overview) with the dialog open.
- Drive the same path headlessly: `GET /api/browse?path=…` then `POST /api/generate` with `{"repoPath":…, "overview":…}`.

## Driving it with verify-city

Preconditions:

- Baseline preconditions from the map README hold.
- `scripts/doctor.sh` exits 0.
- The dev server is yours on port 5199.
- The fixture path is absolute: `$PWD/test/fixtures/mini-repo`.

- **Browse.** Run `curl -s "http://localhost:5199/api/browse?path=$PWD/test/fixtures/mini-repo"`. The response carries `path`, `parent`, an `entries` array containing `packages`, and `isRepo` false. In the browser the same folder shows a breadcrumb, no `git` badge (the fixture is not a repo root), and a `../` parent row.
- **Generate deployment.** Run `curl -s -X POST http://localhost:5199/api/generate -H 'content-type: application/json' -d '{"repoPath":"<abs fixture path>","overview":false}'`. The response carries `map`, `jsonPath` (under `out/mini-repo/`), and `repoPath`; `jsonPath` exists on disk. In the browser the `Deployment map` button shows `Generating…` while busy, then the scene loads the new map.
- **Generate overview.** Repeat with `"overview":true`. The response's `jsonPath` sits under `out/mini-repo-overview/` and the map validates.
- **Second view.** Run `node vendor/functionary/validate-city-map.mjs` over each returned map (or the `jsonPath` file). Exit 0 both times; record both verdicts with this feature ID.
- **Error path.** Run `curl -s -X POST http://localhost:5199/api/generate -H 'content-type: application/json' -d '{"repoPath":"/does/not/exist","overview":false}'`. The response carries `error`; in the browser the dialog shows the `Could not map that folder` alert and stays open.
- **Proof.** Save each request body with its response (or `jsonPath` plus validator verdict) under `$EVIDENCE/map-a-folder/`, labelled with the entry point used (dialog button versus curl).

## Gotchas

- `/api/generate` writes into the checked-in-ignored `out/<basename>` directories, not `$SCRATCH`; concurrent verification runs against different repos still share `out/`, so serialise API drives or accept the shared write. CLI drives (`generate.sh`) isolate by `--out-dir` and are preferred for parallel proof.
- The dialog keyboard (arrows move the highlight, Enter opens a folder, Esc closes, typing jumps with 1s-reset type-ahead) only applies when no modifier is held; ⌘↵/⌘⇧↵ generate instead of navigating.
- A generated map that fails client validation shows an alert and never reaches the scene; the file in `out/` still exists, so a proof must validate the returned map, not just note that the scene did or did not change.
- The API binds localhost by Vite's defaults; do not pass `--host` to expose it — the folder browser can read any server-side path.
