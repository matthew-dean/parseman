/**
 * ONE path, ONE dialect, ONE fixture, profiled — self-time attributable.
 *
 * `bench/table-path-profile.ts` does this for json, and json turned out to be
 * unrepresentative of the shipping grammars in exactly the way that matters:
 * json's trivia is a plain regex that lowers to a fast scanner, while all eight
 * of less's trivia entries are LABELLED and lower to nothing. A cost share
 * measured on json is therefore not a cost share for less, and this exists so
 * the named fixture gets profiled rather than extrapolated to.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/table-profile-one.ts <dialect> <table|compiled|interp> [reps]`
 */
import { Session } from 'node:inspector/promises'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { compose } from '../../src/compiler/linker.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { ENTRY, JESS_ROOT, loadGrammar, type Dialect } from './grammars.ts'

type Entry = Parameters<typeof run>[0]
type ProfileNode = { callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }

const dialect = (process.argv[2] ?? 'less') as Dialect
const which = process.argv[3] ?? 'table'
const reps = Number(process.argv[4] ?? 60)
const FIXTURE = process.env.PM_FIXTURE ?? 'packages/jess/benchmark/benchmark.less'
const input = readFileSync(resolvePath(JESS_ROOT, FIXTURE), 'utf8')

const g = await loadGrammar(dialect, 'ast')
const entry: Entry = which === 'compiled'
  ? (compose([g.rules as never]) as unknown as Record<string, Entry>)[ENTRY]!
  : which === 'interp'
    ? g.rules[ENTRY]! as unknown as Entry
    : tableRules(encodeTable(g.rules, {}))[ENTRY]! as unknown as Entry

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
console.log(`${dialect}/${which} — ${total} samples over ${reps} parses of ${FIXTURE} (${input.length} B)`)
for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`)
}
