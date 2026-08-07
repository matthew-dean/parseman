/**
 * ONE path, ONE process, profiled — so self-time is attributable.
 *
 * `bench/table-time-attribution.ts` profiles a process running several paths; the
 * shares there are diluted by whichever contests ran. This runs exactly one path
 * over one input and reports where ITS time goes, so the table and compiled
 * profiles can be read side by side.
 *
 * ENGINE TOKEN LEGEND — the argv tokens below are a WIRE CONTRACT and keep their
 * historical spelling; this is what each one actually binds:
 *   table     execRules()   the REFERENCE bytecode interpreter (NOT what ships)
 *   compiled  compose()     the shipped ASSEMBLER
 *   interp    the combinator graph
 * There is no source-lowering "codegen" engine to select — it was DELETED in
 * `37c57b5`.
 *
 * Usage: `node bench/table-path-profile.ts <table|compiled|interp> [reps]`
 */
import { Session } from 'node:inspector/promises'
import type { Combinator } from '../src/types.ts'
import { compose } from '../src/compiler/linker.ts'
import { encodeTable } from '../src/table/encode.ts'
import { execRules } from '../src/table/exec.ts'
import { run } from '../src/functional/run.ts'
import { jsonRules, jsonWs } from './table-grammars.ts'
import { LARGE_JSON } from './fixtures.ts'

type Entry = Parameters<typeof run>[0]
type ProfileNode = {
  callFrame: { functionName: string; url: string; lineNumber: number }
  hitCount?: number
}

const which = process.argv[2] ?? 'table'
/** Token -> the engine it actually binds. See the legend in the header. */
const ENGINE_NAME: Record<string, string> = {
  table: 'exec (reference bytecode interpreter)',
  compiled: 'assembled (shipped)',
  interp: 'interpreter (combinator graph)',
}
const reps = Number(process.argv[3] ?? 400)
const map = jsonRules as unknown as Record<string, Combinator<unknown>>

const entry: Entry = which === 'compiled'
  ? (compose([map as never]) as unknown as Record<string, Entry>).Value!
  : which === 'interp'
    ? map.Value! as unknown as Entry
    : execRules(encodeTable(map)).Value! as unknown as Entry

const fn = (): void => { run(entry, LARGE_JSON, { trivia: jsonWs as Entry }) }

const session = new Session()
session.connect()
await session.post('Profiler.enable')
await session.post('Profiler.setSamplingInterval', { interval: 100 })
for (let i = 0; i < 200; i++) fn()
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
  const file = f.url === '' ? '(emitted)' : f.url.replace(/^.*\/(src|bench|node_modules)\//, '$1/')
  by.set(`${f.functionName || '(anon)'}  ${file}:${f.lineNumber + 1}`, (by.get(`${f.functionName || '(anon)'}  ${file}:${f.lineNumber + 1}`) ?? 0) + h)
}
console.log(`${which} = ${ENGINE_NAME[which] ?? 'UNKNOWN TOKEN'} — ${total} samples over ${reps} parses of ${LARGE_JSON.length} B`)
for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)) {
  console.log(`  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`)
}
