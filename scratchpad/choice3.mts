import { encodeTable } from '/Users/matthew/git/worktrees/parseman-review-scope/src/table/encode.ts'
import { OP_CHOICE, OP_RULE, OP_NAMES } from '/Users/matthew/git/worktrees/parseman-review-scope/src/table/ops.ts'
import { choice, literal, node, rules, sequence, type Combinator } from '/Users/matthew/git/worktrees/parseman-review-scope/src/index.ts'
const g = rules<Record<string, Combinator<unknown>>>(gr => ({
  A: node('A', choice(literal('x'), sequence(literal('('), gr.A!, literal(')')), gr.A!), (c: any) => ({ t: 'A', c })),
})) as unknown as Record<string, Combinator<unknown>>
const prog = encodeTable(g)
for (let ip = 0; ip < prog.code.length; ip++) {
  if (prog.code[ip] === OP_CHOICE) {
    const n = prog.code[ip+2]!
    console.log('choice', ip, 'n', n, 'fxi', prog.code[ip+3], 'fxLen', prog.fx.length, 'arms', Array.from({length:n},(_,i)=>prog.code[ip+4+i]).map(a=>`${a}:${OP_NAMES[prog.code[a!]!]}`))
  }
}
