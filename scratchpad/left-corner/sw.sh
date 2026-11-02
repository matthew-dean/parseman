#!/bin/bash
# sw.sh <out> <dialect> [variant]  — env passes PM_LC, PM_LC_PLANT, PM_SWEEP_MATH
cd ~/git/worktrees/parseman-left-corner
export JESS_ROOT=~/git/worktrees/jess-lc PM_BUDGET=0
node --import ./scratchpad/left-corner/register.mjs scratchpad/left-corner/sweep.ts "$2" "${3:-ast}" > "$1"
