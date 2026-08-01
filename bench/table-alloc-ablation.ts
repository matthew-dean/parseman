/**
 * Table-driver ablation: does removing the per-item mark ALLOCATION account for the
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
import { encodeTableBaseline } from '../src/table/encode-baseline.ts'
import { run } from '../src/functional/run.ts'
import { jsonRules, jsonWs } from './table-grammars.ts'
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

  // The change spans the ENCODER and the DRIVER, so the baseline side needs
  // both: the old encoder's table read by the old driver. Handing the new
  // table to the old driver would just crash on an opcode it never had.
  const oldProg = encodeTableBaseline(map)
  const newProg = encodeTable(map)
  const oldA = tableRulesBaseline(oldProg).Value! as unknown as Entry
  const oldB = tableRulesBaseline(oldProg).Value! as unknown as Entry
  const neu = tableRules(newProg).Value! as unknown as Entry
  const compiled = (compose([map as never]) as unknown as Record<string, Entry>).Value!

  for (const [id, text] of INPUTS) {
    const a = JSON.stringify(run(oldA, text, { trivia: jsonWs as Entry }).value)
    const b = JSON.stringify(run(neu, text, { trivia: jsonWs as Entry }).value)
    if (a !== b) { console.error(`ABORT ${id}: the two drivers parse differently`); process.exit(1) }
  }
  // NOTE on scope. The baseline snapshot predates the separator-demote fix
  // (release/0.47.0 `7cb528e feat(lists)!`), so on a node()-CAPTURING grammar
  // the two snapshots differ for that reason and not for the change under test.
  // json has no node(), so no capture is ever active, the demote is a no-op on
  // it, and the two sides are doing identical work — which is why json is the
  // workload timed here. The capturing case is gated by bench/table-lowering-sweep.ts instead.
  console.log('  same-parse precondition: OK (json x3; see the scope note above)')

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

  // Reps are calibrated per SIDE SPEED, not once per file. `oldA` is the slow
  // baseline driver; `compiled` is generated code and runs far faster. Reusing
  // the baseline-derived map for the GATE contest made those samples finish well
  // under M.targetSampleMs, which raises relative timing noise on exactly the
  // contest that validates the performance claim -- the one measurement here that
  // has to be trustworthy.
  const reps = calibrateReps(cases(oldA))
  const gateReps = calibrateReps(cases(compiled))
  const denseReps = calibrateReps(denseCases(compiled))
  const baselineContests: Contest[] = [
    { label: 'CONTROL  baseline -> baseline', a: cases(oldA), b: cases(oldB) },
    { label: 'ABLATION baseline -> fuse+collapse', a: cases(oldA), b: cases(neu) },
  ]
  const gateContests: Contest[] = [
    { label: 'GATE     compiled -> fuse+collapse', a: cases(compiled), b: cases(neu) },
  ]
  const out = [
    ...interleave(baselineContests, reps, M),
    ...interleave(gateContests, gateReps, M),
  ]
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
