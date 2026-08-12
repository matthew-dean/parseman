/**
 * WHAT DOES RECOVERY LOWERING COST A STRICT PARSE?
 *
 * The two legs are the SAME table, the SAME grammar module and the SAME process,
 * differing only in which ASSEMBLY the entry runs:
 *
 *   REC-ON   the assembly built for `{ tolerant: true }` — recovery pieces
 *            everywhere, exactly what a strict parse got before this lane, since
 *            the pieces themselves are `_tolerant`-gated and stay dormant
 *   REC-OFF  the assembly built for `{ tolerant: false }` — the arity-specialised
 *            sequence pieces, no recovery lowered anywhere
 *
 * BOTH ARE RUN STRICTLY (`_tolerant` never set), so no recovery ever fires in
 * either leg and the delta is purely the cost of recovery being AVAILABLE.
 *
 * A CONTROL contest (two independently built REC-OFF assemblies) runs alongside;
 * its delta is this run's noise floor and no row is readable without it.
 * Absolutes are comparable only to the other absolutes IN THIS RUN.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/rec-cost-ms.ts`
 */
import os from 'node:os'
import { readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { encodeTable } from '../../src/table/encode.ts'
import { AssemblyCache, type RunCfg } from '../../src/table/assemble.ts'
import { stampRuleMap } from '../../src/table/stamp.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { assertParseman, corpus, ENTRY, JESS_ROOT, loadGrammar } from './grammars.ts'
import { interleave, median, type Case, type Contest, type Measurement } from '../ab-harness.ts'
import type { TableProgram, TableRule } from '../../src/table/program.ts'

type Entry = Parameters<typeof run>[0]

const M: Measurement = { targetSampleMs: 60, warmup: 3, timed: 5, rounds: 8, runs: 2 }

const PRIMARY = 'packages/jess/benchmark/benchmark.less'

/**
 * `tableRules` with the option set PINNED rather than read off the `ctx`.
 *
 * A copy of that wiring is the only honest way to contest the two assemblies: the
 * production entry picks its assembly from `ctx._tolerant`, and setting
 * `_tolerant` to reach the recovery assembly would also ARM recovery, which is a
 * different measurement (recovery running, not recovery available).
 */
function pinnedRules(prog: TableProgram, cfg: RunCfg): Record<string, TableRule> {
  const cache = new AssemblyCache(prog)
  const a = cache.for(cfg)
  const names = Object.keys(prog.rules)
  const skipOf = prog.scanSkipOf
  let last: unknown
  return stampRuleMap(prog, {
    runRule: (ri, input, pos, ctx) => {
      a.begin(ctx)
      const v = a.pieces[names[ri]!]!(input, pos, ctx)
      // `FAIL` is module-private to `assemble.ts`; it is the only SYMBOL a piece
      // can return, so this is the same test without exporting it for a bench.
      if (typeof v === 'symbol') return -1
      last = v
      return a.end()
    },
    lastValue: () => last,
    scanSkipFor: ri => a.scanSkip[skipOf?.[ri] ?? -1],
  })
}

function secondFixture(): { name: string; input: string } {
  const files = corpus('less')
    .filter(f => !f.name.endsWith('benchmark.less'))
    .sort((a, b) => b.input.length - a.input.length)
  return files[0]!
}

const prov = await assertParseman()
console.log(`parseman ${prov.version} at ${prov.root}`)
console.log(`  jess root ${JESS_ROOT}   node ${process.version}`)
console.log(`  loadavg at start ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)

const primaryPath = resolvePath(JESS_ROOT, PRIMARY)
const FIXTURES: Array<{ name: string; input: string }> = [
  { name: 'benchmark.less', input: readFileSync(primaryPath, 'utf8') },
  secondFixture(),
]
console.log(`  primary  ${primaryPath}  ${statSync(primaryPath).size} B`)
console.log(`  second   ${FIXTURES[1]!.name}  ${FIXTURES[1]!.input.length} B`)

const g = await loadGrammar('less', 'ast')
const prog = encodeTable(g.rules, {})

const OFF: RunCfg = { hostCst: false, trackLines: false, tolerant: false , coverage: false, probe: false }
const ON: RunCfg = { hostCst: false, trackLines: false, tolerant: true , coverage: false, probe: false }

const offA = pinnedRules(prog, OFF)[ENTRY]! as unknown as Entry
const offB = pinnedRules(prog, OFF)[ENTRY]! as unknown as Entry
const onA = pinnedRules(prog, ON)[ENTRY]! as unknown as Entry

function digest(entry: Entry, input: string): string {
  const r = run(entry, input)
  return digestValue({
    ok: r.ok,
    value: r.value,
    unconsumedFrom: r.unconsumedFrom,
    expected: r.ok ? undefined : [...(r.expected ?? [])].sort(),
  })
}

console.log('')
console.log('IDENTITY — a dormant recovery assembly must produce the SAME tree as the strict one.')
for (const f of FIXTURES) {
  const a = digest(offA, f.input)
  const b = digest(onA, f.input)
  if (a !== b) {
    console.error(`ABORT: ${f.name} — rec-on and rec-off DISAGREE on a strict parse.`)
    process.exit(1)
  }
  console.log(`  ${f.name.padEnd(46)} rec-off===rec-on OK`)
}

function makeCases(entry: Entry, tag: string): Case[] {
  return FIXTURES.map(f => ({
    id: f.name,
    detail: `${tag} ${f.input.length} B`,
    parse: () => run(entry, f.input).value,
    run: (reps: number) => { for (let i = 0; i < reps; i++) run(entry, f.input) },
  }))
}

function calibrateReps(cases: readonly Case[]): Map<string, number> {
  const reps = new Map<string, number>()
  for (const c of cases) {
    for (let k = 0; k < 3; k++) c.parse()
    const ts: number[] = []
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now()
      c.parse()
      ts.push(performance.now() - t0)
    }
    reps.set(c.id, Math.max(1, Math.round(M.targetSampleMs / Math.max(median(ts), 0.01))))
  }
  return reps
}

const reps = calibrateReps(makeCases(offA, 'cal'))

const contests: Contest[] = [
  { label: 'CONTROL: rec-off -> rec-off', a: makeCases(offA, 'off'), b: makeCases(offB, 'off') },
  { label: 'CONTROL: rec-off -> rec-off (2)', a: makeCases(offB, 'off'), b: makeCases(offA, 'off') },
  { label: 'THE COST: rec-off -> rec-on', a: makeCases(offA, 'off'), b: makeCases(onA, 'on') },
  { label: 'THE COST: rec-off -> rec-on (2)', a: makeCases(offB, 'off'), b: makeCases(onA, 'on') },
]

const out = interleave(contests, reps, M)
const perParse = (samples: number[], id: string): number => median(samples) / reps.get(id)!

console.log('')
console.log('MILLISECONDS PER STRICT PARSE  (median of interleaved samples, THIS process only)')
for (const f of FIXTURES) {
  const id = f.name
  console.log('')
  console.log(`  ${id}  (${f.input.length} B, ${reps.get(id)} parses per sample)`)
  for (const label of contests.map(c => c.label)) {
    const s = out.get(label)!
    const ref = s.get(`ref|${id}`)!, head = s.get(`head|${id}`)!
    const d = (median(head) / median(ref) - 1) * 100
    let wins = 0
    for (let n = 0; n < head.length; n++) if (head[n]! < ref[n]!) wins++
    console.log(
      `    ${label.padEnd(34)} ref ${perParse(ref, id).toFixed(2).padStart(6)} ms  `
      + `head ${perParse(head, id).toFixed(2).padStart(6)} ms  `
      + `${d >= 0 ? '+' : ''}${d.toFixed(1)}%   ${wins}/${head.length} head wins`,
    )
  }
}

console.log('')
console.log(`  loadavg at end   ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
