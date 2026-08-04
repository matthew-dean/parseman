import { encodeTable } from '/Users/matthew/git/worktrees/parseman-review-scope/src/table/encode.ts'
import { OP_CHOICE, OP_RULE } from '/Users/matthew/git/worktrees/parseman-review-scope/src/table/ops.ts'
import { jsonRules } from '/Users/matthew/git/worktrees/parseman-review-scope/bench/table-grammars.ts'
const prog = encodeTable(jsonRules as never)
let choices = 0, badFx = 0, armRule = 0
for (let ip = 0; ip < prog.code.length; ip++) {
  if (prog.code[ip] !== OP_CHOICE) continue
  const n = prog.code[ip + 2]!
  const fxi = prog.code[ip + 3]!
  choices++
  if (!(fxi >= 0 && fxi < prog.fx.length)) badFx++
  for (let i = 0; i < n; i++) if (prog.code[prog.code[ip + 4 + i]!] === OP_RULE) armRule++
}
console.log({ choices, badFx, armRule, fxLen: prog.fx.length })
