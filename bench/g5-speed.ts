/**
 * G5 parse-speed A/B — the obvious risk, measured rather than assumed.
 *
 * A shared driver can trade emitted bytes for interpretive overhead, so this
 * compares the TABLE path against the SHIPPED compiled path on the same
 * grammar, in ONE process, with the two sides measured in adjacent
 * order-alternated pairs (`bench/ab-harness.ts`'s `interleave`, the repo's
 * controlled-A/B engine — not a new one).
 *
 * A CONTROL contest runs alongside the gate contest: compiled-vs-compiled, i.e.
 * two instances of the SAME path. Its reported delta is this machine's noise
 * floor for this run, and the gate number is only readable against it.
 *
 * The interpreter is measured too, as the existing shared-driver datum: it is
 * also "one driver, grammar as data", and the difference between it and the
 * table path is what the flat encoding and the zero-allocation protocol buy.
 */
import os from 'node:os'
import { interleave, median, type Case, type Contest, type Measurement, sign } from './ab-harness.ts'
import { compose } from '../src/compiler/linker.ts'
import { encodeTable } from '../src/table/encode.ts'
import { tableRules } from '../src/table/exec.ts'
import { run } from '../src/functional/run.ts'
import { jsonRules, jsonWs } from './g5-grammars.ts'
import { LARGE_JSON, MEDIUM_JSON, SMALL_JSON } from './fixtures.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'
import type { Combinator } from '../src/types.ts'

const M: Measurement = { targetSampleMs: 12, warmup: 3, timed: 5, rounds: 6, runs: 2 }

const INPUTS: Array<[string, string]> = [
  ['json/small', SMALL_JSON],
  ['json/medium', MEDIUM_JSON],
  ['json/large', LARGE_JSON],
]

type Entry = Parameters<typeof run>[0]

function makeCases(entry: Entry, tag: string): Case[] {
  return INPUTS.map(([id, text]) => ({
    id,
    detail: `${tag} ${text.length} B`,
    parse: () => run(entry, text, { trivia: jsonWs as Entry }).value,
    run: (reps: number) => { for (let i = 0; i < reps; i++) run(entry, text, { trivia: jsonWs as Entry }) },
  }))
}

function calibrateReps(cases: readonly Case[]): Map<string, number> {
  const reps = new Map<string, number>()
  for (const c of cases) {
    for (let k = 0; k < 5; k++) c.parse()
    const ts: number[] = []
    for (let k = 0; k < 9; k++) {
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

  // Both sides built from the SAME rule map in the SAME process.
  const compiledA = (compose([map as never]) as unknown as Record<string, Entry>).Value!
  const compiledB = (compose([map as never]) as unknown as Record<string, Entry>).Value!
  const table = tableRules(encodeTable(map)).Value! as unknown as Entry
  const interp = map.Value! as unknown as Entry

  // Same-parse precondition: a timing comparison between two different parses
  // is not a comparison.
  for (const [id, text] of INPUTS) {
    const a = JSON.stringify(run(compiledA, text, { trivia: jsonWs as Entry }).value)
    const t = JSON.stringify(run(table, text, { trivia: jsonWs as Entry }).value)
    const i = JSON.stringify(run(interp, text, { trivia: jsonWs as Entry }).value)
    if (a !== t || a !== i) {
      console.error(`ABORT: ${id} — the paths do not produce the same parse; timings would be meaningless.`)
      process.exit(1)
    }
  }
  console.log('  same-parse precondition: OK on all cases')

  const reps = calibrateReps(makeCases(compiledA, 'cal'))

  const contests: Contest[] = [
    { label: 'gate: compiled -> table', a: makeCases(compiledA, 'compiled'), b: makeCases(table, 'table') },
    { label: 'CONTROL: compiled -> compiled', a: makeCases(compiledA, 'compiled'), b: makeCases(compiledB, 'compiled') },
    { label: 'reference: compiled -> interpreter', a: makeCases(compiledA, 'compiled'), b: makeCases(interp, 'interp') },
  ]

  const out = interleave(contests, reps, M)

  console.log('')
  for (const k of contests) {
    const s = out.get(k.label)!
    console.log(k.label)
    for (const [id] of INPUTS) {
      const a = s.get(`ref|${id}`)!
      const b = s.get(`head|${id}`)!
      const dMed = (median(b) / median(a) - 1) * 100
      const dMin = (Math.min(...b) / Math.min(...a) - 1) * 100
      let wins = 0
      for (let n = 0; n < b.length; n++) if (b[n]! < a[n]!) wins++
      console.log(`  ${id.padEnd(12)} median ${sign(dMed).padStart(8)}   min ${sign(dMin).padStart(8)}   B-wins ${wins}/${b.length}   (${median(a).toFixed(3)} -> ${median(b).toFixed(3)} ms per ${reps.get(id)} parses)`)
    }
  }
  console.log('')
  console.log('  Read the gate row AGAINST the control row: the control is two instances of the')
  console.log('  SAME path, so its delta is this run\'s noise floor, not a result.')
}

main()
