#!/usr/bin/env bash
# Deterministic shape census across the four shipping jess grammars.
# One PROCESS per dialect: composeLeaf()'s fuse mutates shared recognition
# pieces in place, so only one variant of one dialect may be realised per run.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p notes/results
OUT=notes/results/mixture-shape.jsonl
: > "$OUT"
for d in css less scss jess; do
  for v in ast cst; do
    node --import ./bench/jess/register.mjs bench/jess/mixture-shape-one.ts "$d" "$v" >> "$OUT" 2>/dev/null || echo "{\"dialect\":\"$d\",\"variant\":\"$v\",\"error\":true}" >> "$OUT"
  done
done
wc -l < "$OUT"
