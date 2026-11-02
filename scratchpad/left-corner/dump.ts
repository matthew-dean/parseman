// Print the encoded table under a rule, to a depth. node --import ../../bench/jess/register.mjs dump.ts less ValueListWithPriority 14
import { resolve as resolvePath } from 'node:path'
import { expandCompact } from '../../src/table/program.ts'
import { captured } from '../../bench/jess/capture.ts'
import { JESS_ROOT } from '../../bench/jess/grammars.ts'
import { OP_NAMES, OP_RULE, OP_NODE, OP_LIT, OP_RX, OP_GATE, OP_CHOICE } from '../../src/table/ops.ts'
import { childSlots } from '../../src/table/child-slots.ts'
type Dialect = string
const [d, rule, depthS] = process.argv.slice(2) as [Dialect, string, string]
const MOD: Record<string, string> = { css: 'packages/syntax/css/css-parser/src/grammar.ts', less: 'packages/syntax/less/less-parser/src/grammar.ts', scss: 'packages/syntax/scss/scss-parser/src/grammar.ts', jess: 'packages/syntax/jess/jess-parser/src/grammar.ts' }
const mod = await import(`pm-capture:${resolvePath(JESS_ROOT, MOD[d]!)}`) as Record<string, unknown>
const want = mod[d + 'Grammar']
const cap = captured.find(c => c.rules === want) ?? captured[0]!
const prog = expandCompact(cap.source)
const ruleName = new Map<number, string>(Object.entries(prog.rules).map(([n, ip]) => [ip as number, n]))
const names = Object.keys(prog.rules)
const code = prog.code
const k = prog.k as unknown[]
const seen = new Set<number>()
function show(ip: number, depth: number, ind: string): void {
  const op = code[ip]!
  let extra = ''
  if (op === OP_RULE) extra = ' ' + names[code[ip + 1]!]
  if (op === OP_NODE) extra = ` type=${String(k[code[ip + 5]!])} flags=${code[ip + 3]} build=${code[ip + 1]}`
  if (op === OP_LIT) extra = ' ' + JSON.stringify(k[code[ip + 1]!])
  if (op === OP_RX) extra = ' ' + String(k[code[ip + 1]!])
  const rn = ruleName.get(ip)
  console.log(`${ind}${OP_NAMES[op]}@${ip}${extra}${rn ? '  <' + rn + '>' : ''}`)
  if (depth <= 0) return
  if (op === OP_RULE) { const t = prog.rules[names[code[ip + 1]!]!] as number; if (seen.has(t)) { console.log(ind + '  …(seen)'); return } seen.add(t); show(t, depth - 1, ind + '  '); return }
  const kids: number[] = []
  childSlots(code, ip, kids)
  for (const c of kids) show(c, depth - 1, ind + '  ')
}
const startIp = /^[0-9]+$/.test(rule) ? Number(rule) : prog.rules[rule] as number
show(startIp, Number(depthS), "")
