/**
 * Aggregate the interleaved timing legs into one table per fixture.
 *
 * Reports, per engine and per fixture: every base reading, every fix reading,
 * the delta of the medians, and the BASE-TO-BASE spread. The last of those is
 * the number the delta has to clear — `fixture.ts`'s own CONTROL is an A/A
 * inside one process, which bounds sampling noise but not run-to-run drift, and
 * run-to-run is what an A/B across separate processes is exposed to.
 *
 * Column names are the CORRECTED ones. `fixture.ts` prints "codegen" for the
 * pm-macro leg, which resolves through `parseman/table` to
 * `src/table/index.ts:28`'s `tableRules as tableRules` — the shipped
 * ASSEMBLER. It prints "table" for a direct `src/table/exec.ts` import — the
 * reference INTERPRETER, which `src/table/index.ts:24-26` says is not on the
 * product path. `src/compiler/codegen.ts` was deleted in 37c57b5.
 */
import { readFileSync, readdirSync } from 'node:fs'

const DIR = '/private/tmp/claude-501/-Users-matthew-git-oss-jess/4b37688e-79c4-4a51-b70f-2d1d40930652/scratchpad/timing2'
const rows = {}

for (const f of readdirSync(DIR).filter(x => x.endsWith('.txt'))) {
  const [leg, , round] = f.replace('.txt', '').split('.')
  const txt = readFileSync(`${DIR}/${f}`, 'utf8')
  let fixture = null
  for (const line of txt.split('\n')) {
    const fx = /^=== (\S+)\s/.exec(line)
    if (fx) { fixture = fx[1]; continue }
    // NOTE the asymmetry, deliberately left in and stated rather than hidden:
    // this matches the assembler's headline line (`codegen (shipped)`) once, but
    // the interpreter's `table` line TWICE per process — once in the headline
    // block and once in the "vs pinned" re-measure, which spells the label the
    // same way. So the interpreter carries two samples per process and the
    // assembler one. Both legs are treated identically, so the DELTA is
    // unaffected; it only means the interpreter's spread is the better-sampled
    // of the two.
    const m = /^ {6}(codegen \(shipped\)|table) +([\d.]+) ms/.exec(line)
    if (m && fixture) {
      const engine = m[1].startsWith('codegen') ? 'assembler' : 'interpreter'
      const key = `${fixture}|${engine}`
      ;(rows[key] ??= { base: [], fix: [] })[leg].push(Number(m[2]))
    }
  }
}

const med = a => { const s = [...a].sort((x, y) => x - y); return s.length === 0 ? NaN : s[(s.length - 1) >> 1] }
const pct = (a, b) => `${((b / a - 1) * 100).toFixed(1)}%`
const spread = a => a.length < 2 ? 'n/a' : `${((Math.max(...a) / Math.min(...a) - 1) * 100).toFixed(1)}%`

console.log('fixture / engine'.padEnd(52), 'base'.padStart(22), 'fix'.padStart(22), 'delta'.padStart(8), 'base-spread'.padStart(12))
for (const [k, v] of Object.entries(rows).sort()) {
  const [fx, eng] = k.split('|')
  const name = `${fx.split('/').pop()} / ${eng}`
  console.log(
    name.padEnd(52),
    v.base.map(x => x.toFixed(2)).join(' ').padStart(22),
    v.fix.map(x => x.toFixed(2)).join(' ').padStart(22),
    pct(med(v.base), med(v.fix)).padStart(8),
    spread(v.base).padStart(12),
  )
}
