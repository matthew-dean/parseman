/**
 * G5 goal-1 check: with the table driver, is parseman still the fastest parser
 * in the JSON comparison?
 *
 * A relative slowdown against parseman's own codegen only matters if it costs
 * the field. This measures the table path against the SAME external parsers the
 * comparison chart uses, in ONE process, paired and order-alternated
 * (`bench/ab-harness.ts`'s `interleave`), with parseman-compiled-vs-itself as
 * the control.
 */
import os from 'node:os'
import { interleave, median, type Case, type Contest, type Measurement, sign } from './ab-harness.ts'
import { compose } from '../src/compiler/linker.ts'
import { encodeTable } from '../src/table/encode.ts'
import { tableRules } from '../src/table/exec.ts'
import { run } from '../src/functional/run.ts'
import { jsonRules, jsonWs } from './g5-grammars.ts'
import { LARGE_JSON, MEDIUM_JSON, SMALL_JSON } from './fixtures.ts'
import { chevrotainJSON, parsimmonJSON, peggyJSON, nearleyJSON, jisonJSON } from './parsers.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'
import type { Combinator } from '../src/types.ts'

const M: Measurement = { targetSampleMs: 20, warmup: 4, timed: 7, rounds: 6, runs: 2 }

const INPUTS: Array<[string, string]> = [
  ['json/small', SMALL_JSON],
  ['json/medium', MEDIUM_JSON],
  ['json/large', LARGE_JSON],
]

type Entry = Parameters<typeof run>[0]
type Parse = (text: string) => unknown

function cases(parse: Parse): Case[] {
  return INPUTS.map(([id, text]) => ({
    id,
    detail: `${text.length} B`,
    parse: () => parse(text),
    run: (reps: number) => { for (let i = 0; i < reps; i++) parse(text) },
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
  const table = tableRules(encodeTable(map)).Value! as unknown as Entry

  const pmCompiled: Parse = t => run(compiledA, t, { trivia: jsonWs as Entry }).value
  const pmCompiledB: Parse = t => run(compiledB, t, { trivia: jsonWs as Entry }).value
  const pmTable: Parse = t => run(table, t, { trivia: jsonWs as Entry }).value

  const rivals: Array<[string, Parse]> = [
    ['chevrotain', t => chevrotainJSON(t)],
    ['peggy', t => peggyJSON(t)],
    ['parsimmon', t => parsimmonJSON(t)],
    ['nearley', t => nearleyJSON(t)],
    ['jison', t => jisonJSON(t)],
  ]

  // Every side must produce the same VALUE, or the timings compare two jobs.
  for (const [id, text] of INPUTS) {
    const want = JSON.stringify(JSON.parse(text))
    for (const [name, p] of [['pm/compiled', pmCompiled], ['pm/table', pmTable], ...rivals] as Array<[string, Parse]>) {
      let got: string
      try { got = JSON.stringify(p(text)) } catch (e) { console.error(`ABORT ${name} ${id}: ${(e as Error).message}`); process.exit(1) }
      if (got !== want) { console.error(`ABORT ${name} ${id}: parsed a DIFFERENT value than JSON.parse`); process.exit(1) }
    }
  }
  console.log('  same-value precondition: OK for every parser on every case')

  const reps = calibrateReps(cases(pmCompiled))
  const contests: Contest[] = [
    { label: 'CONTROL  pm/compiled -> pm/compiled', a: cases(pmCompiled), b: cases(pmCompiledB) },
    { label: 'GATE     pm/compiled -> pm/table', a: cases(pmCompiled), b: cases(pmTable) },
    ...rivals.map(([name, p]) => ({ label: `FIELD    pm/table   -> ${name}`, a: cases(pmTable), b: cases(p) })),
  ]

  const out = interleave(contests, reps, M)
  console.log('')
  console.log('  (positive = B slower than A. `min` is the readable statistic under load;')
  console.log('   the CONTROL row states this run\'s floor for it.)')
  console.log('')
  for (const k of contests) {
    const s = out.get(k.label)!
    const parts: string[] = []
    for (const [id] of INPUTS) {
      const a = s.get(`ref|${id}`)!, b = s.get(`head|${id}`)!
      parts.push(`${id.split('/')[1]}: min ${sign((Math.min(...b) / Math.min(...a) - 1) * 100)}`)
    }
    console.log(`  ${k.label.padEnd(38)} ${parts.join('   ')}`)
  }
}

main()
