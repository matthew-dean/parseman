// Visited sites for one parse, by op, split into inside/outside a named node type's subtree.
import { resolve as resolvePath } from 'node:path'
import { captured } from '../../bench/jess/capture.ts'
import { JESS_ROOT } from '../../bench/jess/grammars.ts'
import { run } from '../../src/functional/run.ts'
import { countSiteVisits } from '../../src/table/assemble.ts'
import { expandCompact } from '../../src/table/program.ts'
import { OP_NAMES, OP_NODE } from '../../src/table/ops.ts'
import { childSlots } from '../../src/table/child-slots.ts'
const MOD: Record<string, string> = { less: 'packages/syntax/less/less-parser/src/grammar.ts', css: 'packages/syntax/css/css-parser/src/grammar.ts' }
const [d, rule, input, exclType = 'ValueListWithPriority'] = process.argv.slice(2) as [string, string, string, string]
const mod = await import(`pm-capture:${resolvePath(JESS_ROOT, MOD[d]!)}`) as Record<string, unknown>
const cap = captured.find(c => c.rules === mod[d + 'Grammar'])!
const prog = expandCompact(cap.source)
const code = prog.code, k = prog.k as unknown[]
const counts = countSiteVisits(prog, rules => { run(rules[rule]! as Parameters<typeof run>[0], JSON.parse(input) as string) })
// sites inside the excluded type's subtrees
const inside = new Set<number>()
const stack: number[] = []
for (let ip = 0; ip < code.length; ip++) if (code[ip] === OP_NODE && k[code[ip + 5]!] === exclType && counts[ip]! > 0) stack.push(ip)
const kids: number[] = []
while (stack.length) { const ip = stack.pop()!; if (inside.has(ip)) continue; inside.add(ip); kids.length = 0; childSlots(code, ip, kids); stack.push(...kids) }
const byOp = (pred: (ip: number) => boolean): Record<string, number> => {
  const o: Record<string, number> = {}
  for (let ip = 0; ip < code.length; ip++) { const c = counts[ip]!; if (c > 0 && pred(ip)) { const n = OP_NAMES[code[ip]!] ?? String(code[ip]); o[n] = (o[n] ?? 0) + c } }
  return o
}
console.log('outside', exclType, JSON.stringify(byOp(ip => !inside.has(ip))))
console.log('inside ', exclType, JSON.stringify(byOp(ip => inside.has(ip))))
const nodes: string[] = []
for (let ip = 0; ip < code.length; ip++) if (counts[ip]! > 0 && code[ip] === OP_NODE && !inside.has(ip)) nodes.push(`${String(k[code[ip + 5]!])}x${counts[ip]}`)
console.log('outside nodes:', nodes.join(' '))
if (process.env.LIST) for (let ip = 0; ip < code.length; ip++) if (counts[ip]! > 0) {
  const op = code[ip]!; let ex = ''
  if (op === OP_NODE) ex = String(k[code[ip + 5]!])
  else if (OP_NAMES[op] === 'LIT' || OP_NAMES[op] === 'RX') ex = String(k[code[ip + 1]!]).slice(0, 50)
  console.log(`  ${ip} ${OP_NAMES[op]} x${counts[ip]} ${ex}`)
}
