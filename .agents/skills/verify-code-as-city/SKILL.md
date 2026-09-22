---
name: verify-code-as-city
description: "Drive code-as-city the way a user does (CLI generator over a repo, three.js viewer in a browser or via its dev API) and capture proof. Reach for it when changing generator, viewer, or heuristic behaviour."
---

# Verify code-as-city

code-as-city has two user surfaces. The primary one is the **CLI generator**:
`bun src/generate-map.ts <target-repo>` turns a repository into a Functionary
city map (`map.json` plus intermediates). The secondary surface is the
**three.js viewer** (`bun run dev`, Vite React app): an empty shell with
showcase cards, a topbar showcase picker, and a "Map a folder" dialog backed
by the dev-server-only API (`/api/browse`, `/api/generate` in
`vite.config.mjs`). Drive the generator with bash; drive the viewer through
its HTTP API or, when browser proof is required, with the agent's own browser
tooling. There is no Playwright/Cypress harness in this repo.

All paths below assume the working directory is the repo root
(`/Users/alistairbayley/git/code-as-city` in this checkout; resolve it with
`git rev-parse --show-toplevel` when in doubt).

## Launch

Every run starts by fixing an ID and two directories. The run owns both;
nothing else in the repo uses them.

```bash
export RUN_ID=$(date +%Y%m%d-%H%M%S)
export SCRATCH=/tmp/cac-verify-$RUN_ID/scratch
export EVIDENCE=/tmp/cac-verify-$RUN_ID/evidence
mkdir -p "$SCRATCH" "$EVIDENCE"
```

One-off prerequisites (skip when already true): `bun install`, then one
`bun run test` (it writes the gitignored
`test/fixtures/mini-repo/coverage/coverage-summary.json` that the coverage
scan reads; without it the generator's coverage input is empty).

- **Generator:** there is no server to keep alive. Launch means the
  prerequisites above are met; each drive is one `bun src/generate-map.ts`
  process writing to its own `--out-dir` under `$SCRATCH`. Ready means the
  process exits 0 and prints the `Wrote …` summary line (see Drive).
- **Viewer:** start exactly one dev server on port 5199 (5173 is the
  documented default and may belong to the user's session; never take it):

```bash
(bun run dev --port 5199 >"$SCRATCH/dev.log" 2>&1 &) && echo $! >"$SCRATCH/dev.pid"
for i in $(seq 1 30); do curl -sf http://localhost:5199/ >/dev/null && break; sleep 1; done
tail -3 "$SCRATCH/dev.log"
```

Ready means `curl -sf http://localhost:5199/` succeeds and the log shows
`VITE … ready`. If the port already answers before you start anything, **stop**:
that instance is not yours (see Isolate). Teardown is in Cleanup.

## Doctor

Run `scripts/doctor.sh` (read-only) whenever anything looks off, and before
the first drive of a session. It checks: bun present; fixture coverage file
exists; the seven `out/` maps imported by
`viewer/lib/local-showcases.ts` exist (a fresh clone lacks them and
`typecheck`/`dev`/`build` fail with TS2307 until the maps are generated or
the imports trimmed); port 5199 state versus `$SCRATCH/dev.pid`.

```bash
./.agents/skills/verify-code-as-city/scripts/doctor.sh [--port 5199]
```

It prints one line per check (`ok …` / `FAIL …`) and exits non-zero on the
first failure. A FAIL tells you what to fix (for missing `out/` maps: run the
generator over the named repositories, or trim the import list to what you
have — both documented in the README under Run). Do not drive against a
failing doctor except to reproduce the failure itself.

## Drive

The harness is `scripts/generate.sh` for the generator plus plain `curl` for
the dev API. Prefer stable handles: CLI flags, route paths
(`/api/browse`, `/api/generate`), dialog button labels (`Deployment map`,
`Module overview`), the `Parent folder` aria-label — never coordinates.

Generator (exit 2 plus `USAGE` on stderr when the target repo is missing):

```bash
# Deployment map (default): districts are deployment hosts and packages.
./.agents/skills/verify-code-as-city/scripts/generate.sh test/fixtures/mini-repo "$SCRATCH/mini"
# Module overview: every file is a module, districts are directories/packages.
./.agents/skills/verify-code-as-city/scripts/generate.sh --overview test/fixtures/mini-repo "$SCRATCH/mini-ov"
```

`generate.sh` runs the generator, validates the result with
`node vendor/functionary/validate-city-map.mjs <out>/map.json`, and appends a
manifest block (command, exit codes, node/edge counts) to
`$EVIDENCE/manifest.txt`. Success looks like:

```
Wrote /tmp/…/mini/{map,deploy-shape,deps-files,deps-rooms,coupling}.json + deps-rooms.dot + {map,deps-rooms}.md
nodes=64 edges=19 hosts=3 scheduled=1 eliminated=1
Valid Functionary City map: Mini Repo (64 nodes, 19 edges)
```

Golden diff (generator changes only): when the work intentionally changes
generator output, the golden maps in `test/golden/` must be regenerated
(commands in the README) — but never before the fresh `map.json` is diffed
against the golden (`repository` normalised to `<fixture>`,
`generatedAt` dropped) and every hunk explained: added/removed node and
edge ids, changed parents/kinds/metrics/descriptions, and added or reworded
warning lines. Per-room sizing after a structural change legitimately shifts
metrics and descriptions; anything else needs a cause. The rule from
experience: an unexplained hunk is a bug until proven otherwise — this
review has caught phantom hosts, mislabeled bands, and undeclared metric
shifts. Regenerate only after the review, re-run the full suite, and record
the explanation with the evidence.

Viewer via the dev API (server must be yours, per Launch):

```bash
curl -s "http://localhost:5199/api/browse?path=$PWD/test/fixtures/mini-repo"
curl -s -X POST http://localhost:5199/api/generate \
  -H 'content-type: application/json' \
  -d '{"repoPath":"<abs path to repo>","overview":false}'
```

`/api/browse` answers `{path, parent, entries[], isRepo}`; `/api/generate`
answers `{map, jsonPath, repoPath}` and writes `out/<basename>` (or
`out/<basename>-overview`). Validate any returned map with
`node vendor/functionary/validate-city-map.mjs` before claiming it renders.

Viewer in a real browser (only when the proof needs pixels): open
`http://localhost:5199/`, choose a showcase card (titled by map name, with a
`language · shape` line) or the `Map a folder` button, and in the dialog use
the `Deployment map` (⌘↵) / `Module overview` (⌘⇧↵) buttons. The dialog shows
`Generating…` while busy and a `Could not map that folder` alert on failure.
There is no checked-in browser harness; use whatever browser tooling the
agent session provides, and record the entry point used with the artifact.

The feature map under `features/` names every supported entry point per
feature. A proof that drives one convenient entry point is incomplete when
the map lists others — report uncovered entry points as not verified.

## Evidence

Write every artifact under `$EVIDENCE` (it survives cleanup by design):

- Generator proof: the emitted `<out>/map.json` copy, the validator stdout,
  the `Wrote …` line, and the manifest block from `generate.sh`.
- API proof: request body plus response body (or at least `jsonPath` and the
  validator result over the returned map).
- Browser proof: the action taken, the resulting state (aria snapshot or
  DOM text plus a screenshot with the app identity visible), and a
  read-only second view of any side effect (the generated `map.json`
  re-validated, the file on disk re-read).
- Always record the feature ID and entry point used with each artifact.

Proof standards: exercise the real user path (`bun src/generate-map.ts`,
the dialog buttons, the documented API) — never internal setters or
test-only endpoints. Capture the action and the resulting state, not just
the final screen. Verify side effects alongside what is visible: files
written (`map.json`, `map.md`, intermediates), rows/status returned, the
validator's verdict. Mocks only where a production boundary already
isolates the external system; this repo's generator reads the local
filesystem and needs no mocks. The `--overview` flag is a real second mode,
not a dry run: it writes a different `map.json`, so verify its output the
same way rather than trusting the flag name.

## Isolate

- Generator runs isolate by `--out-dir`: one unique directory per run under
  `$SCRATCH`. Never point two runs at the same out-dir, and never at a
  checked-in path (`test/golden/`, `out/<showcase>`) except the deliberate
  golden-regeneration flow in the README.
- The viewer dev server is a singleton per port. Port 5199 is the
  verification port; if it answers without `$SCRATCH/dev.pid` pointing at a
  live process you started, refuse to drive it and say so — corrupting the
  user's session is worse than skipping browser proof.
- Browser state persists via the `code-as-city:last-folder` localStorage
  key; a fresh profile (or clearing storage) is the isolated starting
  point. Concurrent browser runs against one server are not supported.

## Cleanup

Kill only what this run started (by PID file, never by process name), remove
scratch state, and leave the evidence in place:

```bash
kill "$(cat "$SCRATCH/dev.pid")" 2>/dev/null; rm -rf "$SCRATCH"
ls "$EVIDENCE"
```

`$EVIDENCE` is never deleted by cleanup; the final `ls` is the check that
the proof survived. Run this cleanup after every failed iteration too, so
broken attempts do not strand servers or scratch directories. Evidence from
superseded attempts may be removed explicitly by path when a retry replaces
it.

## Helpers

- `scripts/doctor.sh [--port 5199]` — read-only pre-drive health check.
  Exits non-zero with a `FAIL` line naming the unmet precondition.
- `scripts/generate.sh [--overview] [--modules-as-buildings] <target-repo> <out-dir>`
  — runs the generator, validates `map.json`, appends the manifest block to
  `$EVIDENCE/manifest.txt` (`EVIDENCE` defaults to `<out-dir>/../evidence`;
  export it per Launch to fix the location). Both scripts are executable;
  a helper you have to reverse-engineer is not a helper, so their usage is
  shown above and each prints usage on bad arguments.
