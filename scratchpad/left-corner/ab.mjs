// Interleaved marginal-instruction A/B with an A/A null.
// node ab.mjs <out.jsonl> <mode jit|jitless> <reps> <case-spec-json...>
// case spec: {"d":"less","rule":"Declaration","input":"color: red;","n1":5000,"n2":105000}
// Legs: A = PM_LC=0, A2 = PM_LC=0 (null), B = PM_LC=1. Order rotates per rep.
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const [out, mode, repsS, ...specs] = process.argv.slice(2)
const reps = Number(repsS)
const root = new URL('../../', import.meta.url).pathname
const LEGS = [['A', '0'], ['A2', '0'], ['B', '1']]
function count(c, lc, n) {
  const args = ['-l', process.execPath, ...(mode === 'jitless' ? ['--jitless'] : []), '--import', './scratchpad/left-corner/register.mjs',
    'scratchpad/left-corner/micro.ts', c.d, 'assembled', c.rule, String(n), c.file ? '@' + c.file : JSON.stringify(c.input)]
  const r = spawnSync('/usr/bin/time', args, { cwd: root, encoding: 'utf8', env: { ...process.env, PM_LC: lc } })
  const m = /(\d+)\s+instructions retired/.exec(r.stderr)
  if (!m || r.status !== 0) throw new Error(r.stderr.slice(-1500))
  return Number(m[1])
}
for (const s of specs) {
  const c = JSON.parse(s)
  const vals = { A: [], A2: [], B: [] }
  for (let i = 0; i < reps; i++) {
    const order = LEGS.slice(i % 3).concat(LEGS.slice(0, i % 3))
    for (const [name, lc] of order) {
      const a = count(c, lc, c.n1), b = count(c, lc, c.n2)
      vals[name].push((b - a) / (c.n2 - c.n1))
    }
  }
  const med = a => { const x = [...a].sort((p, q) => p - q); return x.length % 2 ? x[x.length >> 1] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2 }
  const row = { d: c.d, case: c.file ? c.file.split('/').pop() : c.input, mode, reps, A: med(vals.A), A2: med(vals.A2), B: med(vals.B), raw: vals, load: (await import('node:os')).loadavg()[0] }
  row.null_pct = 100 * (row.A2 - row.A) / row.A
  row.ab_pct = 100 * (row.B - row.A) / row.A
  appendFileSync(out, JSON.stringify(row) + '\n')
  console.log(`${row.d.padEnd(5)} ${String(row.case).padEnd(28)} ${mode.padEnd(8)} A ${row.A.toFixed(0).padStart(11)}  A2 ${row.A2.toFixed(0).padStart(11)} (${row.null_pct.toFixed(2)}%)  B ${row.B.toFixed(0).padStart(11)} (${row.ab_pct.toFixed(2)}%)  load ${row.load.toFixed(1)}`)
}
