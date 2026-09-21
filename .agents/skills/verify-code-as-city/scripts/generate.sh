#!/usr/bin/env bash
# Drive the code-as-city generator the way a user does, then validate the map.
# Usage: generate.sh [--overview] [--modules-as-buildings] <target-repo> <out-dir>
# Appends a manifest block (command, exit codes, counts) to $EVIDENCE/manifest.txt.
set -u
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --overview|--modules-as-buildings) ARGS+=("$1"); shift ;;
    -h|--help) echo "usage: generate.sh [--overview] [--modules-as-buildings] <target-repo> <out-dir>"; exit 0 ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || { echo "usage: generate.sh [--overview] [--modules-as-buildings] <target-repo> <out-dir>" >&2; exit 2; }
TARGET="$1"; OUT="$2"
REPO="$(git rev-parse --show-toplevel)"
EVIDENCE="${EVIDENCE:-$(dirname "$OUT")/evidence}"
mkdir -p "$EVIDENCE"

GEN_LOG="$EVIDENCE/generator-stdout.txt"
bun "$REPO/src/generate-map.ts" "${ARGS[@]}" "$TARGET" --out-dir "$OUT" 2>&1 | tee "$GEN_LOG"
GEN_CODE="${PIPESTATUS[0]}"
[ "$GEN_CODE" -eq 0 ] || { echo "generator exited $GEN_CODE (see $GEN_LOG)" >&2; exit "$GEN_CODE"; }

VAL_LOG="$EVIDENCE/validator-stdout.txt"
node "$REPO/vendor/functionary/validate-city-map.mjs" "$OUT/map.json" 2>&1 | tee "$VAL_LOG"
VAL_CODE="${PIPESTATUS[0]}"

cp "$OUT/map.json" "$EVIDENCE/map.json"
{
  echo "--- $(date -u +%FT%TZ) ---"
  echo "cmd: generate.sh ${ARGS[*]:-} $TARGET $OUT"
  echo "generator_exit: $GEN_CODE"
  echo "validator_exit: $VAL_CODE"
  echo "summary: $(head -n 2 "$GEN_LOG" | tr '\n' ' ')"
  echo "verdict: $(cat "$VAL_LOG")"
} >>"$EVIDENCE/manifest.txt"
exit "$VAL_CODE"
