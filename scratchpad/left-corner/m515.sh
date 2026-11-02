#!/bin/zsh
cd ~/git/worktrees/parseman-left-corner
export JESS_ROOT=~/git/worktrees/jess-lc PM_BUDGET=0
O=/tmp/claude-501/m515.jsonl; : > $O
mic() { echo "{\"rule\":\"Stylesheet\",\"input\":\"$1\",\"n1\":$2,\"n2\":$3}"; }
fil() { echo "{\"rule\":\"Stylesheet\",\"file\":\"/private/tmp/claude-501/-Users-matthew-git-oss-jess/8341857d-0f0c-4f2b-9bb9-258cd289a43b/scratchpad/fixtures/$1\",\"n1\":$2,\"n2\":$3}"; }
node scratchpad/left-corner/ab3.mjs $O jitless 3 "$(mic 'a{color: red;}' 200 10200)" "$(mic 'a{color:red;}' 200 10200)" "$(mic 'a{div:hover{}}' 200 10200)" "$(mic 'a{foo(a);}' 200 10200)" "$(mic 'a{--x: red;}' 200 10200)" "$(fil benchmark.less 1 4)" "$(fil bootstrap4-all.less 1 4)"
node scratchpad/left-corner/ab3.mjs $O jit 5 "$(mic 'a{color: red;}' 5000 105000)" "$(mic 'a{color:red;}' 5000 105000)" "$(mic 'a{div:hover{}}' 5000 105000)" "$(mic 'a{foo(a);}' 5000 105000)" "$(mic 'a{--x: red;}' 5000 105000)" "$(fil benchmark.less 3 13)" "$(fil bootstrap4-all.less 3 13)"
