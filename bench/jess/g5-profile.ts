/**
 * Self-time profile of the ASSEMBLED path on one fixture.
 *
 * `bench/jess/table-profile-one.ts` does this for the bytecode driver, where the
 * answer is dominated by one 1,260-line `exec`. Assembly breaks that into ~2.2k
 * small pieces, so the interesting question changes: what is left is SHARED
 * runtime (capture buffer, trivia scan) and reducers, and this attributes it.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/g5-profile.ts [reps]`
 */
import { Session } from 'node:inspector/promises'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { encodeTable } from '../../src/table/encode.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { run } from '../../src/functional/run.ts'
import { ENTRY, JESS_ROOT, loadGrammar } from './grammars.ts'

type Entry = Parameters<typeof run>[0]
type ProfileNode = { callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }

const reps = Number(process.argv[2] ?? 60)
const FIXTURE = process.env.PM_FIXTURE ?? 'packages/jess/benchmark/benchmark.less'
const input = readFileSync(resolvePath(JESS_ROOT, FIXTURE), 'utf8')

const g = await loadGrammar('less', 'ast')
const entry = assembledRules(encodeTable(g.rules, {}))[ENTRY]! as unknown as Entry
const fn = (): void => { run(entry, input) }

const session = new Session()
session.connect()
await session.post('Profiler.enable')
await session.post('Profiler.setSamplingInterval', { interval: 100 })
for (let i = 0; i < 5; i++) fn()
await session.post('Profiler.start')
for (let i = 0; i < reps; i++) fn()
const { profile: p } = await session.post('Profiler.stop')
session.disconnect()

const nodes = p.nodes as unknown as ProfileNode[]
let total = 0
const by = new Map<string, number>()
for (const n of nodes) {
  const h = n.hitCount ?? 0
  if (h === 0) continue
  total += h
  const f = n.callFrame
  const file = f.url === '' ? '(emitted)' : f.url.replace(/^.*\/(src|bench|packages|node_modules)\//, '$1/')
  const key = `${f.functionName || '(anon)'}  ${file}:${f.lineNumber + 1}`
  by.set(key, (by.get(key) ?? 0) + h)
}
console.log(`assembled — ${total} samples over ${reps} parses of ${FIXTURE} (${input.length} B)`)
for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
  console.log(`  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`)
}
