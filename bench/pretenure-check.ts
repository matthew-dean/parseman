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
 * Usage: pnpm perf:pretenure        (about 3 minutes; run it on Node 24 and Node 26)
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type Config = { cases: Record<string, number>; pads: number[]; processes: number; maxMarkCompacts: number }

const GATE = 'pretenure-check'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONFIG = JSON.parse(readFileSync(path.join(HERE, 'pretenure-check.json'), 'utf8')) as Config

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

const runtime = path.join(stage, 'dist', 'index.js')
const original = readFileSync(runtime, 'utf8')
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS'))
const failures: string[] = []
console.log(`${GATE}: node ${process.version}, ${CONFIG.processes} processes per case and pad, at most ${CONFIG.maxMarkCompacts} mark-compacts each`)
for (const pad of CONFIG.pads) {
  writeFileSync(runtime, pad === 0 ? original : `${original}\nfunction __layoutPad(){let a=0;${'a+=1;'.repeat(Math.max(0, Math.floor((pad - 40) / 5)))}return a}\n`)
  for (const [id, parses] of Object.entries(CONFIG.cases)) {
    const counts: number[] = []
    for (let p = 0; p < CONFIG.processes; p++) {
      const out = execFileSync(process.execPath, ['worker.mjs', id, String(parses)], { cwd: stage, env, encoding: 'utf8' })
      counts.push((JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { markCompacts: number }).markCompacts)
    }
    const worst = Math.max(...counts)
    const ok = worst <= CONFIG.maxMarkCompacts
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  pad ${String(pad).padStart(6)}  ${id.padEnd(16)}  mark-compacts ${counts.join(' ')}`)
    if (!ok) failures.push(`${id} at pad ${pad}: a process ran ${worst} mark-compacts`)
  }
}
writeFileSync(runtime, original)

if (failures.length > 0) {
  console.error(`\n${GATE}: FAILED — a process left the fast mode. Something the parse keeps is built by an object or array literal again; see src/cst/plain.d.ts.\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`\n${GATE}: ok — every process ran in the fast mode`)
