#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
for d in css less scss jess; do
  node --import ./bench/jess/register.mjs bench/jess/mixture-skip-probe.ts "$d" ast 2>/dev/null
done
