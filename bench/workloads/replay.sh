#!/bin/sh
# Replay a known regression through the workload gate N times.
#
# One run is not evidence. The gate's own self-check has measured a single-pass
# swing of ~10% on a loaded machine, so a result that appears once is
# indistinguishable from a burst. Every replay reported in a PR should be five
# runs, and the claim should be how many of them fired.
#
#   bench/workloads/replay.sh <ref> <head-ref> [runs] [extra flags…]
set -eu
REF=$1
HEAD=$2
RUNS=${3:-5}
shift 3 2>/dev/null || shift 2
N=1
while [ "$N" -le "$RUNS" ]; do
  printf '=== run %s/%s: %s -> %s ===\n' "$N" "$RUNS" "$REF" "$HEAD"
  pnpm --silent perf:workloads --ref="$REF" --head-ref="$HEAD" "$@" 2>&1 \
    | grep -E '^  (ok|FAIL)|load average' || true
  N=$((N + 1))
done
