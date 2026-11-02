import { resolve as resolvePath } from 'node:path'
import { captured } from '../../bench/jess/capture.ts'
import { JESS_ROOT } from '../../bench/jess/grammars.ts'
import { expandCompact } from '../../src/table/program.ts'
import { OP_CHOICE, OP_NAMES } from '../../src/table/ops.ts'
import { reachableIps } from '../../src/table/inspect.ts'
const [d, target] = process.argv.slice(2) as [string, string]
const mod = await import(`pm-capture:${resolvePath(JESS_ROOT, 'packages/syntax/less/less-parser/src/grammar.ts')}`) as Record<string, unknown>
const cap = captured.find(c => c.rules === mod[d + 'Grammar'])!
const prog = expandCompact(cap.source); const code = prog.code
for (const ip of reachableIps(prog)) if (code[ip] === OP_CHOICE) {
  const n = code[ip + 2]!
  const arms = Array.from({ length: n }, (_, i) => code[ip + 4 + i]!)
  if (arms.includes(Number(target))) console.log('CHOICE', ip, 'arms', arms.map(a => `${a}:${OP_NAMES[code[a]!]}`).join(' '))
}
