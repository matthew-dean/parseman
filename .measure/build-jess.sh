#!/usr/bin/env bash
# MEASUREMENT SCAFFOLDING — NOT FOR MERGE.
# Rebuild parseman + the jess parsers under one PARSEMAN_MEASURE_DISPATCH mode
# and snapshot the built libs, so modes can be interleaved in ONE process later
# (comparing separate BUILDS is dominated by machine noise — see README).
set -euo pipefail
MODE="${1:-off}"
PM="${PM:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEST="${DEST:-/Users/matthew/git/worktrees/jess-dispatch-measure}"
export PARSEMAN_MEASURE_DISPATCH="$MODE"
export PARSEMAN_GATING=off
(cd "$PM" && node scripts/build.mjs >/dev/null)
cd "$DEST"
pnpm --filter @jesscss/internal-css-recognition build >/dev/null
# One registry file PER PACKAGE: arm ids are assigned per build PROCESS, so two
# packages' registries cannot share an id space. (Within a package, tsdown emits
# ESM and CJS from the same process — the same arm gets two ids, only the ESM one
# is ever hit at runtime. Dedupe static counts; dynamic counts are exact.)
for p in css less scss jess; do
  rm -f "$DEST/packages/$p-parser/arms.json"
  PARSEMAN_MEASURE_OUT="$DEST/packages/$p-parser/arms.json" \
    pnpm --filter "@jesscss/$p-parser" compile >/dev/null
done
for p in css less; do
  D="$DEST/packages/$p-parser/snap/$MODE"; rm -rf "$D"; mkdir -p "$D"
  cp -R "$DEST/packages/$p-parser/lib" "$D/lib"
done
echo "built + snapshotted mode=$MODE"
