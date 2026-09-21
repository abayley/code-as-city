#!/usr/bin/env bash
# Read-only health check for a code-as-city verification run.
# Usage: doctor.sh [--port 5199]
# Exits 0 when the instance is worth driving, non-zero with a FAIL line otherwise.
set -u
PORT=5199
if [ "${1:-}" = "--port" ]; then PORT="${2:?usage: doctor.sh [--port N]}"; fi

fail() { echo "FAIL $1"; exit 1; }
ok() { echo "ok $1"; }

command -v bun >/dev/null 2>&1 || fail "bun not on PATH"
ok "bun $(bun --version)"

REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git checkout"
[ -f "$REPO/test/fixtures/mini-repo/coverage/coverage-summary.json" ] \
  || fail "fixture coverage missing; run: bun run test"
ok "fixture coverage present"

missing=0
for m in aria-evals aria-evals-overview aria-tools aria-tools-overview functionary.dev nzlaw nzlaw-overview; do
  if [ ! -f "$REPO/out/$m/map.json" ]; then echo "FAIL out/$m/map.json missing (viewer typecheck/dev/build need it or trimmed imports)"; missing=1; fi
done
[ "$missing" -eq 0 ] || exit 1
ok "seven local-showcase maps present"

if curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; then
  if [ -n "${SCRATCH:-}" ] && [ -f "$SCRATCH/dev.pid" ] && kill -0 "$(cat "$SCRATCH/dev.pid")" 2>/dev/null; then
    ok "port $PORT answers and is owned by this run (dev.pid)"
  else
    fail "port $PORT answers but is not ours (no live dev.pid); refusing to double-drive"
  fi
else
  ok "port $PORT free"
fi
