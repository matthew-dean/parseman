/**
 * THE MACRO-FUSED SHIPPING ARTIFACT vs `tableRules` OVER THE INTERPRETED FUSE.
 *
 * WHY THIS EXISTS. `bench/jess/g5-ms.ts` and `bench/jess/fixture.ts` disagree by ~24%
 * on the ASSEMBLER while agreeing closely on the reference interpreter — 27.3 ms here
 * against 33.5-34.3 ms there, on `benchmark.less`, both at `6bc265f`. The composition
 * tax cannot explain it: `fixture.ts:277-281` measured that and recorded the tax on the
 * TABLE leg, "while codegen did not move at all", and its own interpreter-dropped
 * re-run moves the assembler -1.5% (css) / +7.0% (less), not -24%.
 *
 * The live hypothesis is that the two harnesses do not measure the same PROGRAM:
 *   - `fixture.ts` measures `import('pm-macro:…')`, the MACRO-FUSED artifact, where
 *     `composeLeaf` picks winners statically at build time.
 *   - `g5-ms.ts` measures `tableRules(encodeTable(rules))`, the assembler over the
 *     INTERPRETED fuse's realised rule map, where cross-piece refs are repointed.
 * Settings are not the variable: `VARIANT_SETTINGS['ast']` is `{}` in both.
 *
 * Both run the SAME engine — the macro emits `import { tableRules } from 'parseman/table'`
 * (`src/plugin/index.ts:2259`), which `src/table/index.ts:28` aliases to `tableRules`.
 * So any gap here is the ARTIFACT, not the driver, and it lands on the SHIPPED path.
 *
 * INSTANCE USE IS BALANCED, which is the whole reason this file does not just add a leg
 * to `g5-ms.ts`. That file puts `asmA` in three contests and `asmB` in one, so its
 * control measures an under-exercised instance and reads +12-15% — an artefact of the
 * wiring, not a noise floor. Here each side gets one instance used twice and one used
 * once, so the two sides are warmed symmetrically and the controls are readable.
 *
 * Usage: node --import ./bench/jess/register.mjs bench/jess/macro-vs-assembled.ts
 */
import os from 'node:os'
import { readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { ENTRY, JESS_ROOT, assertParseman, exportName, loadGrammar } from './grammars.ts'
import { interleave, median, pairedMedianRatio, pairedWins, type Case, type Contest, type Measurement } from '../ab-harness.ts'

type Entry = Parameters<typeof run>[0]

const M: Measurement = { targetSampleMs: 60, warmup: 3, timed: 5, rounds: 8, runs: 2 }
const MODULE = 'packages/syntax/less/less-parser/src/grammar.ts'
const FIXTURE = 'packages/jess/benchmark/benchmark.less'

const prov = await assertParseman()
console.log(`parseman ${prov.version} at ${prov.root}`)
console.log(`  jess root ${JESS_ROOT}   node ${process.version}`)
console.log(`  loadavg at start ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)

const path = resolvePath(JESS_ROOT, FIXTURE)
const input = readFileSync(path, 'utf8')
console.log(`  fixture  ${path}  ${statSync(path).size} B`)

const g = await loadGrammar('less', 'ast')
const prog = encodeTable(g.rules, {})
const asmA = tableRules(prog)[ENTRY]! as unknown as Entry
const asmB = tableRules(prog)[ENTRY]! as unknown as Entry

const modPath = resolvePath(JESS_ROOT, MODULE)
const macroMod = await import(`pm-macro:${modPath}`) as Record<string, unknown>
const macroGrammar = macroMod[exportName('less', 'ast')] as Record<string, unknown>
const macA = macroGrammar[ENTRY] as Entry
if (typeof macA !== 'function') throw new Error('the macro did not run — `compiled` is not a function')
/**
 * The macro artifact is ONE module instance — node caches it, and there is no second
 * lowering to compare against. So `CONTROL: macro -> macro` is the SAME instance on
 * both sides: it measures order and heap effects but NOT instance-to-instance
 * variation, and it is printed as degenerate so nobody reads it as the latter.
 * `CONTROL: assembled -> assembled` is a true two-instance control and is the one to
 * judge the result against.
 */
const macB = macA

console.log(`  macro artifact rules: ${Object.keys(macroGrammar).length}   interpreted-fuse rules: ${Object.keys(g.rules).length}`)

function digest(entry: Entry): string {
  const r = run(entry, input)
  return digestValue({
    ok: r.ok,
    value: r.value,
    unconsumedFrom: r.unconsumedFrom,
    expected: [...(r.expected ?? [])].sort(),
  })
}

console.log('')
const dAsm = digest(asmA)
const dMac = digest(macA)
console.log(`IDENTITY  assembled === macro artifact: ${dAsm === dMac ? 'OK' : 'DIVERGENT — the two artifacts do not agree'}`)
{
  const ra = run(asmA, input)
  const rm = run(macA, input)
  console.log(`  assembled ok=${ra.ok} consumed=${ra.unconsumedFrom ?? input.length}`)
  console.log(`  macro     ok=${rm.ok} consumed=${rm.unconsumedFrom ?? input.length}`)
}

const ID = 'benchmark.less'
function mk(entry: Entry, tag: string): Case[] {
  return [{
    id: ID,
    detail: `${tag} ${input.length} B`,
    parse: () => run(entry, input).value,
    run: (reps: number) => { for (let i = 0; i < reps; i++) run(entry, input) },
  }]
}

/** Calibrate reps so one sample is ~targetSampleMs, exactly as `g5-ms.ts` does. */
const reps = new Map<string, number>()
{
  for (let k = 0; k < 3; k++) run(asmA, input)
  const ts: number[] = []
  for (let k = 0; k < 7; k++) {
    const t0 = performance.now()
    run(asmA, input)
    ts.push(performance.now() - t0)
  }
  reps.set(ID, Math.max(1, Math.round(M.targetSampleMs / median(ts))))
}

const contests: Contest[] = [
  { label: 'CONTROL: assembled -> assembled', a: mk(asmA, 'assembled'), b: mk(asmB, 'assembled') },
  { label: 'CONTROL: macro     -> macro', a: mk(macA, 'macro'), b: mk(macB, 'macro') },
  { label: 'THE Q:   assembled -> macro', a: mk(asmA, 'assembled'), b: mk(macA, 'macro') },
]

const out = interleave(contests, reps, M)
const per = (s: number[]): number => median(s) / reps.get(ID)!

const q = out.get('THE Q:   assembled -> macro')!
const ca = out.get('CONTROL: assembled -> assembled')!
const cm = out.get('CONTROL: macro     -> macro')!
const asmMs = per(q.get(`ref|${ID}`)!)
const macMs = per(q.get(`head|${ID}`)!)
const a1 = q.get(`ref|${ID}`)!, b1 = q.get(`head|${ID}`)!
const wins = pairedWins(a1, b1)
const qRatio = pairedMedianRatio(a1, b1)

console.log('')
console.log(`MILLISECONDS PER PARSE  (${reps.get(ID)} parses per sample, THIS process only)`)
console.log(`  assembled (interpreted fuse)  ${asmMs.toFixed(2).padStart(7)} ms`)
console.log(`  macro artifact (SHIPPED)      ${macMs.toFixed(2).padStart(7)} ms   ${((qRatio - 1) * 100).toFixed(1)}% paired, macro wins ${wins}/${b1.length}`)
console.log(`  ratio  macro / assembled      ${qRatio.toFixed(3)}x paired`)
console.log('')
console.log(`  CONTROL assembled/assembled ${((pairedMedianRatio(ca.get(`ref|${ID}`)!, ca.get(`head|${ID}`)!) - 1) * 100).toFixed(1)}% paired`)
console.log(`  CONTROL macro/macro         ${((pairedMedianRatio(cm.get(`ref|${ID}`)!, cm.get(`head|${ID}`)!) - 1) * 100).toFixed(1)}% paired${macB === macA ? '   (degenerate — same instance both sides)' : ''}`)
console.log(`  loadavg at end   ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
