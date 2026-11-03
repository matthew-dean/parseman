/**
 * PRETENURING REGRESSION CHECK — every process must parse in the fast mode, whatever
 * the bundle layout.
 *
 * V8 decides per object-literal allocation site whether to allocate straight into old
 * space, from where scavenges fall during warm-up. When the objects a parse keeps come
 * from literals, identical processes split into a fast mode and a slow one that runs
 * dozens of mark-compacts, and appending dead code to the bundle re-rolls which is
 * which (#224). Parseman builds its tree objects with constructors so that cannot
 * happen (`src/cst/plain.d.ts`). This check would see a literal creep back in.
 *
 * Method: build `dist/`, bundle `pretenure-worker.ts` onto it, and for each pad in
 * `pretenure-check.json` append that many bytes of never-called code to
 * `dist/index.js`. Run each case in fresh processes under plain `node` and count the
 * mark-compacts each one ran. Fails if any process exceeds `maxMarkCompacts`.
 *
 * Usage:
 *   pnpm perf:pretenure                     about 6 minutes; run it on Node 24 and Node 26
 *   pnpm perf:pretenure --plant=<site>      the same check with one converted site class
 *                                           turned back into a literal; it must FAIL
 *   pnpm perf:pretenure --pads=0,970        override the pads
 *
 * Plants, each applied to the staged copy of `dist/` only: `span`, `leaf`, `node`
 * (default and CST-host nodes), `line-span`, `field`, `buffer` (each turns its
 * `src/cst/plain.js` constructor into one that returns an object literal), and
 * `children` (a default node keeps the capture buffer's array instead of a copy), and
 * `truncated` (every case's input gains a fragment its grammar cannot consume; the worker,
 * which checks each parse succeeds and reaches the end of its input, refuses to count it).
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type Config = { cases: Record<string, number>; pads: number[]; processes: number; maxMarkCompacts: number }

const GATE = 'pretenure-check'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONFIG = JSON.parse(readFileSync(path.join(HERE, 'pretenure-check.json'), 'utf8')) as Config
const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const padsArg = arg('pads')
if (padsArg !== undefined) CONFIG.pads = padsArg.split(',').map(Number)
const plant = arg('plant')

/** A converted site class, turned back into an object literal (one allocation site). */
const PLANTS: Record<string, { file: string; find: RegExp; replace: string } | { append: string }> = {
  span: { append: 'PlainSpan = function (start, end) { return { start, end } }' },
  leaf: { append: "PlainLeaf = function (value, span) { return { _tag: 'leaf', value, span } }" },
  node: { append: "PlainNode = function (type, span, state, children) { return { _tag: 'node', type, span, state, children } }" },
  'line-span': { append: 'PlainLineSpan = function (start, end, startLine, startColumn, endLine, endColumn) { return { start, end, startLine, startColumn, endLine, endColumn } }' },
  field: { append: 'PlainField = function (name, value, span) { return { name, value, span } }' },
  buffer: { append: 'PlainBuf = function (rawOnly, noRaw, rawLen) { return { rawOnly, noRaw, rawLen, single: undefined, ch: undefined, rawSingle: undefined, raw: undefined, tl: undefined } }' },
  // Not a site class: every case's input gains a fragment its grammar cannot consume, so
  // each parse fails or stops early. The worker refuses to count it.
  truncated: { append: '' },
  children: { file: '*', find: /kids ?=== ?EMPTY_CH ?\? ?kids ?: ?\[\.\.\.kids\]/g, replace: 'kids' },
}
if (plant !== undefined && !(plant in PLANTS)) throw new Error(`${GATE}: no plant ${plant}; plants: ${Object.keys(PLANTS).join(', ')}`)

execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })

const stage = path.join(ROOT, '.cache', `${GATE}-run`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
writeFileSync(path.join(stage, 'package.json'), '{ "type": "module" }\n')
cpSync(path.join(HERE, 'workloads', 'fixtures'), path.join(stage, 'fixtures'), { recursive: true })
cpSync(path.join(ROOT, 'dist'), path.join(stage, 'dist'), { recursive: true })
const parsemanEntry = path.join(ROOT, 'src', 'index.ts')
await build({
  entryPoints: [path.join(HERE, 'pretenure-worker.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: path.join(stage, 'worker.mjs'),
  external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
  logLevel: 'error',
  plugins: [{
    name: 'parseman-from-dist',
    setup(ctx) {
      ctx.onResolve({ filter: /src\/index\.ts$/ }, args =>
        path.resolve(args.resolveDir, args.path) === parsemanEntry ? { path: './dist/index.js', external: true } : undefined)
    },
  }],
})

if (plant !== undefined) {
  const p = PLANTS[plant]!
  if (plant === 'truncated') { /* applied by the worker, through PRETENURE_PLANT */ } else if ('append' in p) {
    const file = path.join(stage, 'dist', 'cst', 'plain.js')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n${p.append}\n`)
  } else {
    let hits = 0
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : [])
    for (const file of walk(path.join(stage, 'dist'))) {
      const text = readFileSync(file, 'utf8')
      const next = text.replace(p.find, () => { hits++; return p.replace })
      if (next !== text) writeFileSync(file, next)
    }
    if (hits === 0) throw new Error(`${GATE}: plant ${plant} matched nothing — re-derive it against the current dist`)
  }
  console.log(`${GATE}: PLANT ${plant} applied to the staged dist — this run must FAIL`)
}

const runtime = path.join(stage, 'dist', 'index.js')
const original = readFileSync(runtime, 'utf8')
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS'))
const workerEnv = plant === 'truncated' ? { ...env, PRETENURE_PLANT: 'truncated' } : env
const failures: string[] = []
// The fast mode's own counts depend on heap sizing, so print them: on a smaller machine they
// may read higher and leave less room under maxMarkCompacts.
const calibration: string[] = []
const refused = new Set<string>()
console.log(`${GATE}: node ${process.version}, ${CONFIG.processes} processes per case and pad, at most ${CONFIG.maxMarkCompacts} mark-compacts each`)
for (const pad of CONFIG.pads) {
  writeFileSync(runtime, pad === 0 ? original : `${original}\nfunction __layoutPad(){let a=0;${'a+=1;'.repeat(Math.max(0, Math.floor((pad - 40) / 5)))}return a}\n`)
  for (const [id, parses] of Object.entries(CONFIG.cases)) {
    const counts: number[] = []
    for (let p = 0; p < CONFIG.processes; p++) {
      try {
        const out = execFileSync(process.execPath, ['worker.mjs', id, String(parses)], { cwd: stage, env: workerEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        counts.push((JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { markCompacts: number }).markCompacts)
      } catch (error) {
        // A worker that cannot vouch for a complete parse gives no count: fail the case.
        const reason = String((error as { stderr?: unknown }).stderr ?? error).trim().split('\n').at(-1)
        counts.push(Number.POSITIVE_INFINITY)
        if (!refused.has(`${id}:${pad}`)) failures.push(`${id} at pad ${pad}: the worker refused to count — ${reason}`)
        refused.add(`${id}:${pad}`)
      }
    }
    const worst = Math.max(...counts)
    if (pad === CONFIG.pads[0]) calibration.push(`${id} ${counts.map(c => Number.isFinite(c) ? String(c) : 'refused').join('/')}`)
    const ok = worst <= CONFIG.maxMarkCompacts
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  pad ${String(pad).padStart(6)}  ${id.padEnd(16)}  mark-compacts ${counts.map(c => Number.isFinite(c) ? String(c) : 'refused').join(' ')}`)
    if (!ok && Number.isFinite(worst)) failures.push(`${id} at pad ${pad}: a process ran ${worst} mark-compacts`)
  }
}
writeFileSync(runtime, original)
console.log(`\n${GATE}: calibration at pad ${CONFIG.pads[0]} (mark-compacts per process): ${calibration.join(', ')}`)

if (failures.length > 0) {
  console.error(`\n${GATE}: FAILED — ${refused.size > 0 ? 'a worker could not vouch for a complete parse, or ' : ''}a process left the fast mode. A leak back into the slow mode means something the parse keeps is built by an object or array literal again; see src/cst/plain.d.ts.\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`\n${GATE}: ok — every process ran in the fast mode`)
