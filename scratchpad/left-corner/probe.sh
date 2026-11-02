#!/bin/bash
# probe.sh <label> : per-declaration marginal in a block, LC=1, JIT and jitless
cd ~/git/worktrees/parseman-left-corner
export JESS_ROOT=~/git/worktrees/jess-lc PM_BUDGET=0 PM_LC=${PM_LC:-1}
B1='a{color: red;}'
B21=$(python3 -c "print('a{' + 'color: red;'*21 + '}')")
node --import ./scratchpad/left-corner/register.mjs scratchpad/left-corner/micro.ts less assembled Stylesheet 1 "\"$B1\"" >/dev/null 2>&1
m() { node scratchpad/left-corner/instr.mjs less assembled Stylesheet "$1" $2 $3 $4 $5 | python3 -c "import json,sys; print(json.load(sys.stdin)['med'])"; }
j1=$(m "$B1" jit 5000 55000 3); j21=$(m "$B21" jit 500 5500 3)
l1=$(m "$B1" jitless 100 2100 3); l21=$(m "$B21" jitless 10 210 3)
echo "$1 LC=$PM_LC per-decl JIT $(( (j21 - j1) / 20 ))  jitless $(( (l21 - l1) / 20 ))"
