import { spawnSync } from 'node:child_process'
const [d, rule, input, which, mode = 'jit', n1s, n2s, repsS] = process.argv.slice(2)
const N1 = Number(n1s ?? (mode === 'jit' ? 5000 : 200)), N2 = Number(n2s ?? (mode === 'jit' ? 105000 : 2200)), reps = Number(repsS ?? 5)
const root = new URL('../../', import.meta.url).pathname
function count(n) {
  const r = spawnSync('/usr/bin/time', ['-l', process.execPath, ...(mode === 'jitless' ? ['--jitless'] : []), '--import', './scratchpad/left-corner/register.mjs', 'scratchpad/left-corner/reducers.ts', d, rule, JSON.stringify(input), 'loop', String(n), which], { cwd: root, encoding: 'utf8', env: process.env })
  const m = /(\d+)\s+instructions retired/.exec(r.stderr); if (!m || r.status !== 0) throw new Error(r.stderr.slice(-1500)); return Number(m[1])
}
const v = []; for (let i = 0; i < reps; i++) { const a = count(N1), b = count(N2); v.push((b - a) / (N2 - N1)) }
v.sort((x, y) => x - y); console.log(JSON.stringify({ which, mode, med: Math.round(v[v.length >> 1]), spread: [Math.round(v[0]), Math.round(v.at(-1))] }))
