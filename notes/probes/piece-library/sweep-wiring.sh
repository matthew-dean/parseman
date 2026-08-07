#!/bin/zsh
for W in A B C D; do
  for S in 1 8 64; do
    out=$(node --trace-turbo-inlining wiring.mjs $W $S 2>&1)
    n=$(print -r -- "$out" | grep -cE "Inlining .*<SharedFunctionInfo leaf>. into .*<SharedFunctionInfo seq$W>")
    print -r -- "wiring=$W sites=$S  leaf->seq$W inlined=$n"
  done
done
