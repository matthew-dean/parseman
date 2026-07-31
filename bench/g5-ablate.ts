/**
 * G5 ablation: does removing the per-item mark ALLOCATION account for the
 * widening gap?
 *
 * `src/table/exec-baseline.ts` is the driver as committed at `c11cc60` —
 * identical in every respect except that it allocates `saveCstMark` /
 * `saveTriviaMark` objects unconditionally in the repetition and choice loops.
 * Both drivers are loaded in ONE process and run over `interleave`, paired and
 * order-alternated, with baseline-vs-baseline as the control.
 *
 * Same table, same grammar, same reducers: the ONLY difference between the two
 * sides is the allocation.
 */
import os from 'node:os'
import { interleave, median, type Case, type Contest, type Measurement, sign } from './ab-harness.ts'
import { compose } from '../src/compiler/linker.ts'
import { encodeTable } from '../src/table/encode.ts'
import { tableRules } from '../src/table/exec.ts'
import { tableRulesBaseline } from '../src/table/exec-baseline.ts'
import { run } from '../src/functional/run.ts'
import { jsonRules, jsonWs, baseNodes } from './g5-grammars.ts'
import { LARGE_JSON, MEDIUM_JSON, SMALL_JSON } from './fixtures.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'
import type { Combinator } from '../src/types.ts'

const M: Measurement = { targetSampleMs: 20, warmup: 4, timed: 7, rounds: 8, runs: 2 }

const INPUTS: Array<[string, string]> = [
  ['json/small', SMALL_JSON],
  ['json/medium', MEDIUM_JSON],
  ['json/large', LARGE_JSON],
]

type Entry = Parameters<typeof run>[0]

function cases(entry: Entry): Case[] {
  return INPUTS.map(([id, text]) => ({
    id,
    detail: `${text.length} B`,
    parse: () => run(entry, text, { trivia: jsonWs as Entry }).value,
    run: (reps: number) => { for (let i = 0; i < reps; i++) run(entry, text, { trivia: jsonWs as Entry }) },
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

  const prog = encodeTable(map)
  const oldA = tableRulesBaseline(prog).Value! as unknown as Entry
  const oldB = tableRulesBaseline(prog).Value! as unknown as Entry
  const neu = tableRules(prog).Value! as unknown as Entry
  const compiled = (compose([map as never]) as unknown as Record<string, Entry>).Value!

  for (const [id, text] of INPUTS) {
    const a = JSON.stringify(run(oldA, text, { trivia: jsonWs as Entry }).value)
    const b = JSON.stringify(run(neu, text, { trivia: jsonWs as Entry }).value)
    if (a !== b) { console.error(`ABORT ${id}: the two drivers parse differently`); process.exit(1) }
  }
  // The ablation must not have changed the tree for a CAPTURING grammar either,
  // which is the case the guard deliberately leaves alone.
  {
    const bp = encodeTable(baseNodes)
    const a = JSON.stringify(run(tableRulesBaseline(bp).Doc! as never, '(a,1)zz(b)7').value)
    const b = JSON.stringify(run(tableRules(bp).Doc! as never, '(a,1)zz(b)7').value)
    if (a !== b) { console.error('ABORT: node()-capturing grammar diverges between drivers'); process.exit(1) }
  }
  console.log('  same-parse precondition: OK (json x3 + a node()-capturing grammar)')

  // SECOND ABLATION — trivia. The driver reaches trivia through the runtime's
  // `advanceTrivia` (a WeakMap scanner lookup plus several ctx branches, per
  // term and per repetition item); codegen inlines a charCode loop. If that is
  // a per-item cost, the gap should shrink on input with NO trivia to skip.
  const dense = INPUTS.map(([id, t]) => [`${id}-dense`, JSON.stringify(JSON.parse(t))] as [string, string])
  function denseCases(entry: Entry): Case[] {
    return dense.map(([id, text]) => ({
      id,
      detail: `${text.length} B, no trivia`,
      parse: () => run(entry, text).value,
      run: (reps: number) => { for (let i = 0; i < reps; i++) run(entry, text) },
    }))
  }

  const reps = calibrateReps(cases(oldA))
  const denseReps = calibrateReps(denseCases(compiled))
  const contests: Contest[] = [
    { label: 'CONTROL  baseline -> baseline', a: cases(oldA), b: cases(oldB) },
    { label: 'ABLATION baseline -> inline-term', a: cases(oldA), b: cases(neu) },
    { label: 'GATE     compiled -> inline-term', a: cases(compiled), b: cases(neu) },
  ]
  const out = interleave(contests, reps, M)
  const denseContests: Contest[] = [
    { label: 'CONTROL  compiled -> compiled  (no trivia)', a: denseCases(compiled), b: denseCases(compiled) },
    { label: 'GATE     compiled -> table     (no trivia)', a: denseCases(compiled), b: denseCases(neu) },
  ]
  const denseOut = interleave(denseContests, denseReps, M)
  console.log('')
  console.log('  (positive = B slower. `min` is the readable statistic under load.)')
  console.log('')
  for (const k of contests) {
    const s = out.get(k.label)!
    const parts: string[] = []
    for (const [id] of INPUTS) {
      const a = s.get(`ref|${id}`)!, b = s.get(`head|${id}`)!
      parts.push(`${(id.split('/')[1] ?? id).padEnd(6)} min ${sign((Math.min(...b) / Math.min(...a) - 1) * 100).padStart(8)}`)
    }
    console.log(`  ${k.label.padEnd(32)} ${parts.join('  ')}`)
  }
  console.log('')
  for (const k of denseContests) {
    const s = denseOut.get(k.label)!
    const parts: string[] = []
    for (const [id] of dense) {
      const a = s.get(`ref|${id}`)!, b = s.get(`head|${id}`)!
      parts.push(`${(id.split('/')[1] ?? id).padEnd(12)} min ${sign((Math.min(...b) / Math.min(...a) - 1) * 100).padStart(8)}`)
    }
    console.log(`  ${k.label.padEnd(42)} ${parts.join('  ')}`)
  }
}

main()
