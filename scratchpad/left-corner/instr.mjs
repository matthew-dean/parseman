// Marginal instructions: node instr.mjs <dialect> <engine> <rule> <input> [jit|jitless] [N1] [N2] [reps] [variant]
// Runs micro.ts under /usr/bin/time -l at N1 and N2 parses, reps times interleaved, prints median (I(N2)-I(N1))/(N2-N1).
// --jitless is a measurement MODE the brief asks for (both modes reported), not a tuning flag.
import { spawnSync } from 'node:child_process'
const [dialect, engine, rule, input, mode = 'jit', n1s, n2s, repsS, variant = 'ast'] = process.argv.slice(2)
const N1 = Number(n1s ?? (mode === 'jit' ? 2000 : 20)), N2 = Number(n2s ?? (mode === 'jit' ? 12000 : 120)), reps = Number(repsS ?? 5)
const root = new URL('../../', import.meta.url).pathname
function count(n) {
  const args = ['-l', process.execPath, ...(mode === 'jitless' ? ['--jitless'] : []), '--import', './scratchpad/left-corner/register.mjs', 'scratchpad/left-corner/micro.ts', dialect, engine, rule, String(n), JSON.stringify(input), variant]
  const r = spawnSync('/usr/bin/time', args, { cwd: root, encoding: 'utf8', env: process.env })
  const m = /(\d+)\s+instructions retired/.exec(r.stderr)
  if (!m || r.status !== 0) throw new Error(r.stderr.slice(-2000))
  return Number(m[1])
}
const vals = []
for (let i = 0; i < reps; i++) { const a = count(N1), b = count(N2); vals.push((b - a) / (N2 - N1)) }
vals.sort((x, y) => x - y)
const med = vals[vals.length >> 1]
console.log(JSON.stringify({ dialect, engine, rule, input, mode, med: Math.round(med), spread: [Math.round(vals[0]), Math.round(vals.at(-1))] }))
