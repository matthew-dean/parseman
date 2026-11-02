// ab2.mjs <mode> <reps> <spec> <envB-json...> : A = PM_LC=0, then each B variant with env; interleaved
import { spawnSync } from 'node:child_process'
const [mode, repsS, spec, ...envs] = process.argv.slice(2)
const c = JSON.parse(spec); const reps = Number(repsS)
const root = new URL('../../', import.meta.url).pathname
const legs = [['A', { PM_LC: '0' }], ...envs.map((e, i) => ['B' + i, { PM_LC: '1', ...JSON.parse(e) }])]
function count(env, n) {
  const r = spawnSync('/usr/bin/time', ['-l', process.execPath, ...(mode === 'jitless' ? ['--jitless'] : []), '--import', './scratchpad/left-corner/register.mjs', 'scratchpad/left-corner/micro.ts', c.d, 'assembled', c.rule, String(n), JSON.stringify(c.input)], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
  const m = /(\d+)\s+instructions retired/.exec(r.stderr); if (!m) throw new Error(r.stderr.slice(-800)); return Number(m[1])
}
const v = Object.fromEntries(legs.map(([n]) => [n, []]))
for (let i = 0; i < reps; i++) for (const [n, env] of legs) { const a = count(env, c.n1), b = count(env, c.n2); v[n].push((b - a) / (c.n2 - c.n1)) }
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1]
const A = med(v.A)
for (const [n] of legs) console.log(n, JSON.stringify(legs.find(l => l[0] === n)[1]), Math.round(med(v[n])), (100 * (med(v[n]) - A) / A).toFixed(2) + '%')
