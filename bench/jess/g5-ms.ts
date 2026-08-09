/**
 * THE NAMED FIXTURE, IN MILLISECONDS — `compose()` vs the reference bytecode
 * interpreter vs the closure assembler. `benchmark.less`, 106,802 B, AST path.
 *
 * WHICH ENGINES THIS BINDS. `compose()` (`src/compiler/linker.ts`) and
 * `tableRules()` (`src/table/assemble.ts`) are both the shipped ASSEMBLER,
 * reached by two routes; `execRules()` (`src/table/exec.ts`) is the REFERENCE
 * bytecode interpreter and is NOT what ships. No source-lowering "codegen"
 * engine is timed here — the source lowering was DELETED in `37c57b5`.
 *
 * This is `bench/jess/table-less-ms.ts`'s instrument with one leg added, kept as
 * a separate file so that harness's own gate (`table- === table`) is untouched.
 * Every property that makes a number here readable comes from `ab-harness.ts`:
 * all legs built from the SAME grammar module in the SAME process, interleaved,
 * order-alternated, calibrated on one side and applied to both.
 *
 * A CONTROL contest runs alongside — two independently built instances of the
 * SAME path — and its delta is this run's noise floor. No row is readable
 * without it, and an absolute millisecond figure is only comparable to the other
 * absolutes IN THIS RUN. Cross-launch comparison is not a comparison: this
 * machine has produced 9.4 ms and 26 ms for the same case in consecutive runs.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/g5-ms.ts`
 */
import os from 'node:os'
import { readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { compose } from '../../src/compiler/linker.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { assertParseman, corpus, ENTRY, JESS_ROOT, loadGrammar } from './grammars.ts'
import { interleave, median, pairedMedianRatio, pairedWins, type Case, type Contest, type Measurement } from '../ab-harness.ts'

type Entry = Parameters<typeof run>[0]

const M: Measurement = { targetSampleMs: 60, warmup: 3, timed: 5, rounds: 8, runs: 2 }

const PRIMARY = 'packages/jess/benchmark/benchmark.less'

/** A second fixture, structurally unlike the first — the penalty tracks which
 *  CONSTRUCTS a file exercises, not its size. */
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

const compiledA = (compose([g.rules as never]) as unknown as Record<string, Entry>)[ENTRY]!
const compiledB = (compose([g.rules as never]) as unknown as Record<string, Entry>)[ENTRY]!
const execTable = execRules(prog)[ENTRY]! as unknown as Entry
const asmA = tableRules(prog)[ENTRY]! as unknown as Entry
const asmB = tableRules(prog)[ENTRY]! as unknown as Entry

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
console.log('IDENTITY — `exec === assembled` is a GATE; `=== compiled` is context (known outlier).')
for (const f of FIXTURES) {
  const dc = digest(compiledA, f.input)
  const de = digest(execTable, f.input)
  const da = digest(asmA, f.input)
  if (de !== da) {
    console.error(`ABORT: ${f.name} — the assembler CHANGED THE TREE. That is a defect, not a win.`)
    process.exit(1)
  }
  console.log(`  ${f.name.padEnd(46)} exec===assembled OK   ===compiled ${da === dc ? 'OK' : 'NO  <- compiled outlier'}`)
}

/** ASSEMBLY COST — paid once per process, per option set. NOT the metric. */
{
  const t0 = performance.now()
  const n = 10
  for (let i = 0; i < n; i++) tableRules(prog)
  const build = (performance.now() - t0) / n
  const t1 = performance.now()
  for (let i = 0; i < n; i++) execRules(prog)
  const drv = (performance.now() - t1) / n
  console.log('')
  console.log(`ASSEMBLY  ${build.toFixed(2)} ms per rule-map   (bytecode driver build: ${drv.toFixed(2)} ms)`)
  console.log('  Paid ONCE per process per option set, and proportional to the REACHED subset.')
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
  { label: 'CONTROL:  compiled  -> compiled', a: makeCases(compiledA, 'compiled'), b: makeCases(compiledB, 'compiled') },
  { label: 'CONTROL:  assembled -> assembled', a: makeCases(asmA, 'assembled'), b: makeCases(asmB, 'assembled') },
  { label: 'THE WIN:  exec      -> assembled', a: makeCases(execTable, 'exec'), b: makeCases(asmA, 'assembled') },
  { label: 'THE GATE: compiled  -> assembled', a: makeCases(compiledA, 'compiled'), b: makeCases(asmA, 'assembled') },
]

const out = interleave(contests, reps, M)

const perParse = (samples: number[], id: string): number => median(samples) / reps.get(id)!

console.log('')
console.log('MILLISECONDS PER PARSE  (median of the interleaved samples, THIS process only)')
for (const f of FIXTURES) {
  const id = f.name
  const ctlC = out.get('CONTROL:  compiled  -> compiled')!
  const ctlA = out.get('CONTROL:  assembled -> assembled')!
  const win = out.get('THE WIN:  exec      -> assembled')!
  const gate = out.get('THE GATE: compiled  -> assembled')!
  const compiledMs = perParse(ctlC.get(`ref|${id}`)!, id)
  const execMs = perParse(win.get(`ref|${id}`)!, id)
  const asmMs = perParse(win.get(`head|${id}`)!, id)
  const asmGateMs = perParse(gate.get(`head|${id}`)!, id)
  const ctlCd = (pairedMedianRatio(ctlC.get(`ref|${id}`)!, ctlC.get(`head|${id}`)!) - 1) * 100
  const ctlAd = (pairedMedianRatio(ctlA.get(`ref|${id}`)!, ctlA.get(`head|${id}`)!) - 1) * 100
  const a = win.get(`ref|${id}`)!, b = win.get(`head|${id}`)!
  const wins = pairedWins(a, b)
  const winRatio = pairedMedianRatio(a, b)

  console.log('')
  console.log(`  ${id}  (${f.input.length} B, ${reps.get(id)} parses per sample)`)
  console.log(`    exec      (bytecode)  ${execMs.toFixed(2).padStart(7)} ms`)
  console.log(`    assembled (closures)  ${asmMs.toFixed(2).padStart(7)} ms   <- ${((winRatio - 1) * 100).toFixed(1)}% paired, ${wins}/${b.length} wins`)
  console.log(`    assembled (2nd leg)   ${asmGateMs.toFixed(2).padStart(7)} ms   (same leg, other contest — agreement is the sanity check)`)
  console.log(`    assembled (compose)   ${compiledMs.toFixed(2).padStart(7)} ms`)
  console.log(`    REMAINING GAP         ${(asmMs - compiledMs).toFixed(2).padStart(7)} ms   (${(asmMs / compiledMs).toFixed(2)}x)`)
  console.log(`    controls: compiled ${ctlCd >= 0 ? '+' : ''}${ctlCd.toFixed(1)}%   assembled ${ctlAd >= 0 ? '+' : ''}${ctlAd.toFixed(1)}%   <- the noise floor`)
}

console.log('')
console.log(`  loadavg at end   ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
