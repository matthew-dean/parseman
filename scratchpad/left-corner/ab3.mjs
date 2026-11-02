// ab3.mjs <out> <mode> <reps> <spec...>: legs swap the Less grammar file and PM_LC, interleaved.
import { spawnSync } from 'node:child_process'
import { copyFileSync, appendFileSync } from 'node:fs'
const [out, mode, repsS, ...specs] = process.argv.slice(2)
const reps = Number(repsS)
const root = new URL('../../', import.meta.url).pathname
const SP = '/private/tmp/claude-501/-Users-matthew-git-oss-jess/8341857d-0f0c-4f2b-9bb9-258cd289a43b/scratchpad'
const G = process.env.HOME + '/git/worktrees/jess-lc/packages/syntax/less/less-parser/src/grammar.ts'
const D = process.env.HOME + '/git/worktrees/jess-lc/packages/syntax/less/less-parser/src/declaration-reducers.ts'
const LEGS = [['base', 'grammar.less.orig.ts', '0'], ['base2', 'grammar.less.orig.ts', '0'], ['j515', 'grammar.less.515.ts', '0'], ['lc', 'grammar.less.orig.ts', '1'], ['j515+lc', 'grammar.less.515.ts', '1']]
function count(c, leg, n) {
  copyFileSync(`${SP}/${leg[1]}`, G)
  const args = ['-l', process.execPath, ...(mode === 'jitless' ? ['--jitless'] : []), '--import', './scratchpad/left-corner/register.mjs', 'scratchpad/left-corner/micro.ts', 'less', 'assembled', c.rule, String(n), c.file ? '@' + c.file : JSON.stringify(c.input)]
  const r = spawnSync('/usr/bin/time', args, { cwd: root, encoding: 'utf8', env: { ...process.env, PM_LC: leg[2] } })
  const m = /(\d+)\s+instructions retired/.exec(r.stderr)
  if (!m || r.status !== 0) throw new Error(r.stderr.slice(-1500))
  return Number(m[1])
}
void D
for (const s of specs) {
  const c = JSON.parse(s)
  const v = Object.fromEntries(LEGS.map(l => [l[0], []]))
  for (let i = 0; i < reps; i++) {
    const order = LEGS.slice(i % LEGS.length).concat(LEGS.slice(0, i % LEGS.length))
    for (const leg of order) { const a = count(c, leg, c.n1), b = count(c, leg, c.n2); v[leg[0]].push((b - a) / (c.n2 - c.n1)) }
  }
  const med = a => { const x = [...a].sort((p, q) => p - q); return x[x.length >> 1] }
  const A = med(v.base)
  const row = { case: c.file ? c.file.split('/').pop() : c.input, mode, med: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, med(x)])), raw: v }
  appendFileSync(out, JSON.stringify(row) + '\n')
  console.log(`${String(row.case).padEnd(26)} ${mode.padEnd(8)} ` + Object.entries(row.med).map(([k, x]) => `${k} ${Math.round(x)} (${(100 * (x - A) / A).toFixed(2)}%)`).join('  '))
}
copyFileSync(`${SP}/grammar.less.orig.ts`, G)
