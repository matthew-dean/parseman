#!/bin/zsh
for B in 1 4 16; do
  out=$(node --trace-turbo-inlining budget.mjs $B 2>&1)
  sz=$(print -r -- "$out" | grep -oE "SharedFunctionInfo callee.., bytecode size: [0-9]+" | grep -oE "[0-9]+$" | sort -u | tr '\n' ' ')
  inl=$(print -r -- "$out" | grep -cE "Inlining .*<SharedFunctionInfo callee>. into .*<SharedFunctionInfo parent>")
  not=$(print -r -- "$out" | grep -cE "Not inlining .*callee.*into .*parent")
  print -r -- "B=$B callee-bytecode=[$sz] inlined=$inl not-inlined=$not"
done
