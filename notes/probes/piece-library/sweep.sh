#!/bin/zsh
# ILLUSTRATIVE PROBE DRIVER. For each N, report whether the k0(...) call site
# inside the shared seq2 piece inlined its callee.
for N in 1 2 3 4 5 6 8 12 20 64; do
  out=$(node --trace-turbo-inlining "$1" $N 2>&1)
  inl=$(print -r -- "$out" | grep -c "Inlining.*SharedFunctionInfo leaf.*into.*SharedFunctionInfo seq2")
  notinl=$(print -r -- "$out" | grep -c "Not inlining.*leaf.*into.*seq2")
  seq2inl=$(print -r -- "$out" | grep -c "Inlining.*SharedFunctionInfo seq2.*into.*SharedFunctionInfo drive")
  print -r -- "N=$N  leaf->seq2 inlined=$inl  not-inlined=$notinl  seq2->drive inlined=$seq2inl"
done
