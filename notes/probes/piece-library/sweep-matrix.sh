#!/bin/zsh
# TRACE-ONLY (no timing; timing is serialised across lanes).
# 2x2+: wiring in {A closure-captured, D generic kids[i] loop}
#       K = number of distinct callee FunctionLiterals reaching the child slot.
for W in A D; do
  for K in 1 2 4 8; do
    out=$(node --trace-turbo-inlining matrix.mjs $W $K 2>&1)
    names=$(print -r -- "$out" | grep -oE "Inlining .*<SharedFunctionInfo leaf[0-9]>. into .*<SharedFunctionInfo seq$W>" | grep -oE "leaf[0-9]" | sort -u | tr '\n' ',')
    print -r -- "wiring=$W callee-kinds=$K  inlined-into-parent:[$names]"
  done
done
