/**
 * THE NAMED FIXTURE, IN MILLISECONDS — `benchmark.less`, 106,802 B, AST path.
 *
 * The owner's target is `codegen 17.41 ms, table 46.86` and he wants to watch
 * that number move, so this reports absolute medians rather than percentages.
 * The interpreter is timed alongside as the third absolute.
 *
 * FOUR legs, all from the SAME grammar module in the SAME process:
 *
 *   compiled   `compose()` — the shipped codegen, fused at runtime
 *   table-     `tableRules(prog, { leafSwap: false })`  the driver BEFORE the swap
 *   table      `tableRules(prog)`                       the driver WITH it
 *   interp     the combinator graph
 *
 * `table-` and `table` are the same driver code differing only in TABLE DATA
 * (an all-null `triviaScan`), which is what makes the swap's cost measurable in
 * one process on a machine where cross-run comparison is not reliable.
 *
 * TWO CAVEATS, both stated rather than hidden:
 *
 * 1. `benchmark.less` is a COMPILED OUTLIER. The table and the interpreter agree
 *    on `value` and `span`; the shipped codegen engine is the odd one out. So the
 *    three parses are NOT identical and the milliseconds are indicative of cost,
 *    not a like-for-like contest. This prints the digest agreement rather than
 *    aborting on it, so a tree difference can never quietly become a speed claim.
 *    `table-` vs `table` IS like-for-like and is gated hard: a swap that changed
 *    the tree is a defect, not a win.
 * 2. The penalty does NOT track input size — a sibling lane measured 4.11x on a
 *    275 KB file against 2.69x on this 107 KB one, same dialect. It tracks which
 *    CONSTRUCTS a file exercises. So a second, structurally different less
 *    fixture is timed alongside, and a result that does not hold on both is
 *    reported as not holding.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/table-less-ms.ts`
 */
import os from 'node:os'
import { readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { Combinator } from '../../src/types.ts'
import { compose } from '../../src/compiler/linker.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { assertParseman, corpus, ENTRY, JESS_ROOT, loadGrammar } from './grammars.ts'
import { interleave, median, type Case, type Contest, type Measurement } from '../ab-harness.ts'

type Entry = Parameters<typeof run>[0]

const M: Measurement = { targetSampleMs: 60, warmup: 3, timed: 5, rounds: 8, runs: 2 }

const PRIMARY = 'packages/jess/benchmark/benchmark.less'

/** A second fixture, structurally unlike the first — see caveat 2. */
function secondFixture(): { name: string; input: string } {
  // The largest `.less` the corpus holds that is not the primary: a different
  // construct mix by virtue of being a different authored file, and large enough
  // that per-parse fixed costs do not dominate.
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

const compiledA = (compose([g.rules as never]) as unknown as Record<string, Entry>)[ENTRY]!
const compiledB = (compose([g.rules as never]) as unknown as Record<string, Entry>)[ENTRY]!
const tableOld = tableRules(prog, { leafSwap: false })[ENTRY]! as unknown as Entry
const tableNew = tableRules(prog)[ENTRY]! as unknown as Entry
const interp = g.rules[ENTRY]! as unknown as Entry

/** Digest the whole outcome, as the identity sweep does — not just the value. */
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
console.log('IDENTITY — printed, not assumed. `table- === table` is a GATE; the rest is context.')
for (const f of FIXTURES) {
  const dc = digest(compiledA, f.input)
  const dOld = digest(tableOld, f.input)
  const dNew = digest(tableNew, f.input)
  const di = digest(interp, f.input)
  if (dOld !== dNew) {
    console.error(`ABORT: ${f.name} — the leaf swap CHANGED THE TREE. That is a defect, not a win.`)
    process.exit(1)
  }
  console.log(`  ${f.name.padEnd(46)} table-===table OK   table===interp ${dNew === di ? 'OK ' : 'NO '}  table===compiled ${dNew === dc ? 'OK' : 'NO  <- compiled outlier'}`)
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

const reps = calibrateReps(makeCases(compiledA, 'cal'))

const contests: Contest[] = [
  { label: 'CONTROL', a: makeCases(compiledA, 'compiled'), b: makeCases(compiledB, 'compiled') },
  { label: 'table- -> table', a: makeCases(tableOld, 'table-'), b: makeCases(tableNew, 'table') },
  { label: 'compiled -> table', a: makeCases(compiledA, 'compiled'), b: makeCases(tableNew, 'table') },
  { label: 'compiled -> interp', a: makeCases(compiledA, 'compiled'), b: makeCases(interp, 'interp') },
]

const out = interleave(contests, reps, M)

/** ms per ONE parse, from a sample of `reps` parses. */
const perParse = (samples: number[], id: string): number => median(samples) / reps.get(id)!

console.log('')
console.log('MILLISECONDS PER PARSE  (median of the interleaved samples)')
for (const f of FIXTURES) {
  const id = f.name
  const control = out.get('CONTROL')!
  const swap = out.get('table- -> table')!
  const gate = out.get('compiled -> table')!
  const ref = out.get('compiled -> interp')!
  const compiledMs = perParse(control.get(`ref|${id}`)!, id)
  const oldMs = perParse(swap.get(`ref|${id}`)!, id)
  const newMs = perParse(swap.get(`head|${id}`)!, id)
  const tableMs = perParse(gate.get(`head|${id}`)!, id)
  const interpMs = perParse(ref.get(`head|${id}`)!, id)
  const ctlDelta = (median(control.get(`head|${id}`)!) / median(control.get(`ref|${id}`)!) - 1) * 100
  let wins = 0
  const a = swap.get(`ref|${id}`)!, b = swap.get(`head|${id}`)!
  for (let n = 0; n < b.length; n++) if (b[n]! < a[n]!) wins++

  console.log('')
  console.log(`  ${id}  (${f.input.length} B, ${reps.get(id)} parses per sample)`)
  console.log(`    interp          ${interpMs.toFixed(2).padStart(7)} ms`)
  console.log(`    table- (before) ${oldMs.toFixed(2).padStart(7)} ms`)
  console.log(`    table  (after)  ${newMs.toFixed(2).padStart(7)} ms    <- the swap: ${(newMs - oldMs).toFixed(2)} ms, ${((newMs / oldMs - 1) * 100).toFixed(1)}%, ${wins}/${b.length} wins`)
  console.log(`    table  (gate)   ${tableMs.toFixed(2).padStart(7)} ms    (same leg, second contest — agreement is the sanity check)`)
  console.log(`    codegen         ${compiledMs.toFixed(2).padStart(7)} ms`)
  console.log(`    REMAINING GAP   ${(newMs - compiledMs).toFixed(2).padStart(7)} ms   (${(newMs / compiledMs).toFixed(2)}x)   control ${ctlDelta >= 0 ? '+' : ''}${ctlDelta.toFixed(1)}%`)
}

console.log('')
console.log(`  loadavg at end   ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
