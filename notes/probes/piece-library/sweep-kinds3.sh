#!/bin/zsh
# k1 is always `tail`; k0 varies over M distinct FunctionLiterals.
# Report which callee SFIs inlined into seq2 (the shared parent piece).
for M in 1 2 3 4 5 6 8; do
  out=$(node --trace-turbo-inlining kinds2.mjs $M 2>&1)
  k0=$(print -r -- "$out" | grep -oE "Inlining .*<SharedFunctionInfo kind[A-H]>. into .*<SharedFunctionInfo seq2>" | grep -oE "kind[A-H]" | sort -u | tr '\n' ',')
  k1=$(print -r -- "$out" | grep -cE "Inlining .*<SharedFunctionInfo tail>. into .*<SharedFunctionInfo seq2>")
  print -r -- "M=$M  k0 slot inlined:[$k0]   k1 slot (always tail) inlined=$k1"
done
