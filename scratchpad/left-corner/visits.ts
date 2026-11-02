// Site visits under the base engine: Value's choice, its arms, and how many arm attempts fail.
import { resolve as resolvePath } from 'node:path'
import { readFileSync } from 'node:fs'
import { captured } from '../../bench/jess/capture.ts'
import { JESS_ROOT } from '../../bench/jess/grammars.ts'
import { run } from '../../src/functional/run.ts'
import { countSiteVisits } from '../../src/table/assemble.ts'
import { expandCompact } from '../../src/table/program.ts'
import { OP_CHOICE, OP_NODE } from '../../src/table/ops.ts'
const MOD: Record<string, string> = { css: 'packages/syntax/css/css-parser/src/grammar.ts', less: 'packages/syntax/less/less-parser/src/grammar.ts', scss: 'packages/syntax/scss/scss-parser/src/grammar.ts', jess: 'packages/syntax/jess/jess-parser/src/grammar.ts' }
const [d, file, typeName = 'Value'] = process.argv.slice(2) as [string, string, string]
const mod = await import(`pm-capture:${resolvePath(JESS_ROOT, MOD[d]!)}`) as Record<string, unknown>
const want = mod[d + 'Grammar']
const cap = captured.find(c => c.rules === want)!
const prog = expandCompact(cap.source)
const input = readFileSync(file, 'utf8')
const counts = countSiteVisits(prog, rules => { const r = run(rules['Stylesheet']! as Parameters<typeof run>[0], input); if (!r.ok) throw new Error('parse failed') })
const code = prog.code, k = prog.k as unknown[]
// every node of the type, its body choice and arms
for (let ip = 0; ip < code.length; ip++) {
  if (code[ip] !== OP_NODE || k[code[ip + 5]!] !== typeName) continue
  const body = code[ip + 2]!
  if (code[body] !== OP_CHOICE || counts[ip] === 0) continue
  const n = code[body + 2]!
  const arms = Array.from({ length: n }, (_, i) => code[body + 4 + i]!)
  const armVisits = arms.map(a => counts[a]!)
  const sum = armVisits.reduce((x, y) => x + y, 0)
  console.log(`${typeName}@${ip} visits=${counts[ip]} choice=${counts[body]} armEntries=${sum} failedArmEntries=${sum - counts[body]!}`)
  console.log('  per arm: ' + armVisits.map((v, i) => `${i}:${v}`).join(' '))
}
