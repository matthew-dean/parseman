#!/bin/zsh
set -e
cd ~/git/worktrees/parseman-left-corner
export JESS_ROOT=~/git/worktrees/jess-lc PM_BUDGET=0
OUT=/tmp/claude-501/matrix.jsonl
: > $OUT
mic() { echo "{\"d\":\"$1\",\"rule\":\"Declaration\",\"input\":\"$2\",\"n1\":$3,\"n2\":$4}"; }
fil() { echo "{\"d\":\"$1\",\"rule\":\"Stylesheet\",\"file\":\"/private/tmp/claude-501/-Users-matthew-git-oss-jess/8341857d-0f0c-4f2b-9bb9-258cd289a43b/scratchpad/fixtures/$2\",\"n1\":$3,\"n2\":$4}"; }
for mode in jit jitless; do
  if [ $mode = jit ]; then a=5000; b=205000; fa=3; fb=13; reps=7; else a=200; b=20200; fa=1; fb=4; reps=5; fi
  for d in less scss jess css; do
    m4='width: 1px + 2px * 3;'; [ $d = jess ] && m4='width: $(1px + 2px * 3);'; [ $d = css ] && m4='width: calc(1px + 2px * 3);'
    node scratchpad/left-corner/ab.mjs $OUT $mode $reps "$(mic $d 'color: red;' $a $b)" "$(mic $d 'margin: 0 auto;' $a $b)" "$(mic $d 'font: 12px/1.5 a, b;' $a $b)" "$(mic $d "$m4" $a $b)"
  done
  node scratchpad/left-corner/ab.mjs $OUT $mode $reps "$(fil less benchmark.less $fa $fb)" "$(fil less bootstrap4-all.less $fa $fb)" "$(fil css benchmark.css $fa $fb)" "$(fil scss gen-workload.scss $fa $fb)" "$(fil jess jess-x8.jess $((fa*10)) $((fb*10)))"
done
