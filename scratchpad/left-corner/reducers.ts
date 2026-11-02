// Census: which reducers run for one parse, and what each costs alone.
// node --import ./register.mjs reducers.ts <dialect> <rule> <input-json> [mode: record|loop] [N] [which]
import { resolve as resolvePath } from 'node:path'
import { captured } from '../../bench/jess/capture.ts'
import { JESS_ROOT } from '../../bench/jess/grammars.ts'
import { run } from '../../src/functional/run.ts'
const MOD: Record<string, string> = { css: 'packages/syntax/css/css-parser/src/grammar.ts', less: 'packages/syntax/less/less-parser/src/grammar.ts', scss: 'packages/syntax/scss/scss-parser/src/grammar.ts', jess: 'packages/syntax/jess/jess-parser/src/grammar.ts' }
const [d, rule, inputJson, mode = 'record', nS = '0', which = 'all'] = process.argv.slice(2) as string[]
const mod = await import(`pm-capture:${resolvePath(JESS_ROOT, MOD[d!]!)}`) as Record<string, Record<string, Parameters<typeof run>[0]>>
const g = mod[d + 'Grammar']!
const cap = captured.find(c => c.rules === g)!
const f = (cap.source as { f?: unknown[]; fns?: unknown[] }).f ?? (cap.source as { fns: unknown[] }).fns
const calls: { i: number; args: unknown[] }[] = []
for (let i = 0; i < f.length; i++) {
  const fn = f[i]
  if (typeof fn !== 'function') continue
  f[i] = function (this: unknown, ...args: unknown[]) { calls.push({ i, args }); return (fn as (...a: unknown[]) => unknown).apply(this, args) }
}
const input = JSON.parse(inputJson!) as string
const r = run(g[rule!]!, input)
if (!r.ok) throw new Error('parse failed')
const orig = calls.map(c => ({ i: c.i, args: c.args }))
// unwrap: loop over the ORIGINAL fns with recorded args
const fnsOrig: Record<number, (...a: unknown[]) => unknown> = {}
// rebuild originals by re-importing is not possible; recorded wrapper holds `fn` via closure — call through the wrapper but drop recording
calls.length = 0
if (mode === 'record') {
  for (const c of orig) console.log(c.i, JSON.stringify(c.args[0], (_k, v) => typeof v === 'object' && v !== null && 'type' in v ? `<${String((v as { type: string }).type)}>` : v)?.slice(0, 100))
} else {
  const N = Number(nS)
  const sel = which === 'all' ? orig : orig.filter(c => which.split(',').includes(String(c.i)))
  let s = 0
  for (let n = 0; n < N; n++) { for (const c of sel) { s += (f[c.i] as (...a: unknown[]) => unknown)(...c.args) === undefined ? 0 : 1 }; calls.length = 0 }
  if (s < 0) console.log(s)
}
void fnsOrig
