#!/usr/bin/env bash
# THE DETERMINISTIC HALF OF THE SWEEP — bytes, driver rows, ok, consumed.
#
# No timing here; every number below re-reads identically on any box, so this
# runs without a slot. Timing rows are appended later by the A/B harness and
# carry the same `mix` key.
#
# Both directions. Forward = single flip from ALL-SPECIALISED (the shipped
# configuration). Reverse = single flip from ALL-SHARED (`*,-X`). They are not
# mirrors: where the two rankings disagree is where the interaction effects are.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=notes/results/mixture-sweep.jsonl
mkdir -p notes/results
: > "$OUT"

SHA=$(git rev-parse HEAD)
NODEV=$(node --version)

# Every construct kind the census found in a shipping grammar, plus the three
# reducer-invoking ones. A kind with zero sites in a dialect is not skipped: it
# is the MECHANISM CONTROL for that dialect (mix set, nothing selected).
KINDS="NODE LEAF XFORM SCOPE LIT SEQV RX CHOICE OPT GATE REPV NOT ROUTED SCAN REP TOKEN FIELD SEQ DISPATCH PEEK LABEL ATTEMPT EXPECT RULE LIT_CI"

emit() { # <dialect> <mixspec> <direction>
  local d=$1 mix=$2 dir=$3
  local line
  line=$(PM_MIX_DRIVER="$mix" PM_TABLE_COUNT=1 node --import ./bench/jess/register.mjs \
           bench/jess/mixture-route-probe.ts "$d" ast 2>/dev/null | tail -1)
  if [ -z "$line" ]; then
    echo "{\"dialect\":\"$d\",\"mix\":\"$mix\",\"direction\":\"$dir\",\"error\":\"probe produced no output\"}" >> "$OUT"
    echo "  FAIL $d $dir $mix"
    return
  fi
  echo "$line" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const o=JSON.parse(s);
      o.direction=process.argv[1]; o.parsemanSha=process.argv[2]; o.node=process.argv[3];
      o.capoffLanded=false;
      o.specialisedVia="new Function (experimental scaffolding; shipped form is build-time emitted source of the same shape)";
      o.timing=null;
      process.stdout.write(JSON.stringify(o)+"\n");
    })' "$dir" "$SHA" "$NODEV" >> "$OUT"
}

for d in css less scss jess; do
  echo "== $d"
  emit "$d" ""  endpoint-specialised
  emit "$d" "*" endpoint-shared
  for k in $KINDS; do
    emit "$d" "$k"    forward
    emit "$d" "*,-$k" reverse
  done
done
wc -l < "$OUT"
