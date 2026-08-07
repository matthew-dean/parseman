/**
 * WHY the REFERENCE bytecode interpreter's gap widens with input size.
 *
 * WHICH ENGINES THIS BINDS. `execRules()` (`src/table/exec.ts`) is the REFERENCE
 * bytecode interpreter, NOT what ships; `compose()` (`src/compiler/linker.ts`)
 * is the shipped ASSEMBLER. No source-lowering "codegen" engine is involved —
 * `src/compiler/codegen.ts` was DELETED in `37c57b5`.
 *
 * Two rival explanations, and they predict different curves:
 *
 *   A) a PER-ITEM cost in the driver's hot loop. The ratio would keep climbing
 *      with input size, without bound.
 *   B) a shared PER-PARSE fixed cost (ctx setup, `run()` bookkeeping, the entry
 *      wrapper) that both sides pay identically. On a tiny input it dominates
 *      and DILUTES the ratio; as the input grows its share falls and the ratio
 *      rises toward the true steady-state ratio — an ASYMPTOTE, not a ramp.
 *
 * Both explanations fit three points. Eight points separate them. Same grammar,
 * same driver, one process, interleaved against the assembled path with an
 * assembled-vs-assembled control.
 */
import os from 'node:os'
import { interleave, median, type Case, type Contest, type Measurement, sign } from './ab-harness.ts'
import { compose } from '../src/compiler/linker.ts'
import { encodeTable } from '../src/table/encode.ts'
import { execRules } from '../src/table/exec.ts'
import { run } from '../src/functional/run.ts'
import { jsonRules } from './table-grammars.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'
import type { Combinator } from '../src/types.ts'

const M: Measurement = { targetSampleMs: 15, warmup: 4, timed: 5, rounds: 6, runs: 2 }

/** One record repeated N times — work scales linearly, shape is constant. */
function jsonOfSize(records: number): string {
  const rec = '{"id":12345,"name":"widget","tags":["a","b","c"],"ok":true,"n":-1.5e3,"x":null}'
  return `[${Array.from({ length: records }, () => rec).join(',')}]`
}

const SIZES = [1, 2, 4, 8, 16, 64, 256, 1024]
const INPUTS: Array<[string, string]> = SIZES.map(n => [`n=${n}`, jsonOfSize(n)])

type Entry = Parameters<typeof run>[0]

function cases(entry: Entry): Case[] {
  return INPUTS.map(([id, text]) => ({
    id,
    detail: `${text.length} B`,
    parse: () => run(entry, text).value,
    run: (reps: number) => { for (let i = 0; i < reps; i++) run(entry, text) },
  }))
}

function calibrateReps(cs: readonly Case[]): Map<string, number> {
  const reps = new Map<string, number>()
  for (const c of cs) {
    for (let n = 0; n < 5; n++) c.parse()
    const ts: number[] = []
    for (let n = 0; n < 9; n++) {
      const t0 = performance.now()
      c.parse()
      ts.push(performance.now() - t0)
    }
    reps.set(c.id, Math.max(1, Math.round(M.targetSampleMs / Math.max(median(ts), 0.01))))
  }
  return reps
}

function main(): void {
  const map = jsonRules as unknown as Record<string, Combinator<unknown>>
  console.log(`parseman ${PARSEMAN_VERSION}   ${process.cwd()}   node ${process.version}`)
  console.log(`  loadavg ${os.loadavg().map(n => n.toFixed(1)).join(' ')}`)

  const compiledA = (compose([map as never]) as unknown as Record<string, Entry>).Value!
  const compiledB = (compose([map as never]) as unknown as Record<string, Entry>).Value!
  const table = execRules(encodeTable(map)).Value! as unknown as Entry

  for (const [id, text] of INPUTS) {
    const want = JSON.stringify(JSON.parse(text))
    if (JSON.stringify(run(compiledA, text).value) !== want) { console.error(`ABORT ${id}: assembled`); process.exit(1) }
    if (JSON.stringify(run(table, text).value) !== want) { console.error(`ABORT ${id}: exec`); process.exit(1) }
  }
  console.log('  same-value precondition: OK at every size')

  const reps = calibrateReps(cases(compiledA))
  const contests: Contest[] = [
    { label: 'control: assembled -> assembled', a: cases(compiledA), b: cases(compiledB) },
    { label: 'gate: assembled -> exec', a: cases(compiledA), b: cases(table) },
  ]
  const out = interleave(contests, reps, M)

  console.log('')
  console.log('    records      bytes    control(min)     exec(min)   exec ratio')
  const ctl = out.get('control: assembled -> assembled')!, gate = out.get('gate: assembled -> exec')!
  for (let i = 0; i < INPUTS.length; i++) {
    const [id, text] = INPUTS[i]!
    const ca = ctl.get(`ref|${id}`)!, cb = ctl.get(`head|${id}`)!
    const ga = gate.get(`ref|${id}`)!, gb = gate.get(`head|${id}`)!
    const cd = (Math.min(...cb) / Math.min(...ca) - 1) * 100
    const gd = (Math.min(...gb) / Math.min(...ga) - 1) * 100
    console.log(`  ${id.padEnd(9)} ${String(text.length).padStart(8)}  ${sign(cd).padStart(12)}  ${sign(gd).padStart(12)}   ${(1 + gd / 100).toFixed(2)}x`)
  }
  console.log('')
  console.log('  A RAMP (ratio still climbing at n=1024) => a per-item cost in the driver.')
  console.log('  An ASYMPTOTE (ratio flat from some n onward) => shared per-parse fixed cost')
  console.log('  diluting the small-input ratio, and the flat value is the real one.')
}

main()
