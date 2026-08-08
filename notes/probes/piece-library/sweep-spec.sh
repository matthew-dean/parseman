#!/bin/zsh
for M in shared specialised wrapper pasted; do
  out=$(node --trace-turbo-inlining specialise.mjs $M 2>&1)
  into=$(print -r -- "$out" | grep -oE "Inlining .*<SharedFunctionInfo (leaf[A-H]|tail|pieceWrapper)>. into .*<SharedFunctionInfo seq[A-Za-z0-9]+>" | sed -E 's/.*SharedFunctionInfo (leaf[A-H]|tail|pieceWrapper)..into.*SharedFunctionInfo (seq[A-Za-z0-9]+).*/\1->\2/' | sort -u | tr '\n' ' ')
  deep=$(print -r -- "$out" | grep -cE "Inlining .*<SharedFunctionInfo leaf[A-H]>. into .*<SharedFunctionInfo pieceWrapper>")
  print -r -- "mode=$M"
  print -r -- "   inlined: $into"
  print -r -- "   leaf->wrapper inlines: $deep"
done
