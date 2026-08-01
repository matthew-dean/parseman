/**
 * WHERE the table driver's time goes.
 *
 * Two independent instruments, because a plausible mechanism has been wrong
 * three times in this lane and a measurement has been right three times:
 *
 *   1. a V8 CPU profile of the table path, attributed to FUNCTION, so the answer
 *      names a callee rather than a theory;
 *   2. an ABLATION ladder — the same parse with one suspected cost removed at a
 *      time — so each candidate gets a number rather than a share of a profile.
 *
 * The scaling is the thing to explain: the gap widens with input size
 * (+82% small, +228% medium, +275% large). A constant interpretive overhead
 * cannot do that. Something is per-item.
 */
import { Session } from 'node:inspector/promises'
import { writeFileSync } from 'node:fs'
import { compose } from '../src/compiler/linker.ts'
import { encodeTable } from '../src/table/encode.ts'
import { tableRules } from '../src/table/exec.ts'
import { run } from '../src/functional/run.ts'
import { jsonRules, jsonWs } from './table-grammars.ts'
import { LARGE_JSON } from './fixtures.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'
import type { Combinator } from '../src/types.ts'

type Entry = Parameters<typeof run>[0]

type ProfileNode = {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: number[]
  hitCount?: number
}

async function profile(label: string, fn: () => void, reps: number, out: string): Promise<void> {
  const session = new Session()
  session.connect()
  await session.post('Profiler.enable')
  await session.post('Profiler.setSamplingInterval', { interval: 100 })
  for (let i = 0; i < 50; i++) fn()
  await session.post('Profiler.start')
  for (let i = 0; i < reps; i++) fn()
  const { profile: p } = await session.post('Profiler.stop')
  session.disconnect()
  writeFileSync(out, JSON.stringify(p))

  const nodes = p.nodes as unknown as ProfileNode[]
  const total = nodes.reduce((a, n) => a + (n.hitCount ?? 0), 0)
  const byFn = new Map<string, number>()
  for (const n of nodes) {
    const h = n.hitCount ?? 0
    if (h === 0) continue
    const f = n.callFrame
    const file = f.url.replace(/^.*\/(src|bench|node_modules)\//, '$1/')
    const key = `${f.functionName || '(anon)'}  ${file}:${f.lineNumber + 1}`
    byFn.set(key, (byFn.get(key) ?? 0) + h)
  }
  console.log(`  ${label} — ${total} samples, profile at ${out}`)
  for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`    ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
  }
  console.log('')
}

async function main(): Promise<void> {
  console.log(`parseman ${PARSEMAN_VERSION}   ${process.cwd()}   node ${process.version}`)
  console.log('')
  const map = jsonRules as unknown as Record<string, Combinator<unknown>>
  const compiled = (compose([map as never]) as unknown as Record<string, Entry>).Value!
  const table = tableRules(encodeTable(map)).Value! as unknown as Entry
  const text = LARGE_JSON
  const triviaOpt = { trivia: jsonWs as Entry }

  console.log('=== CPU profile, LARGE json, attributed to function')
  await profile('table   ', () => { run(table, text, triviaOpt) }, 300, '/tmp/pm-table-table.cpuprofile')
  await profile('compiled', () => { run(compiled, text, triviaOpt) }, 300, '/tmp/pm-table-compiled.cpuprofile')
}

void main()
