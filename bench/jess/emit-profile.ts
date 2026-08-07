/**
 * ONE LEG, ALONE, IN ITS OWN PROCESS — the profiling counterpart to `ab.ts`.
 *
 * `ab.ts` produces a RATIO and is built to defend that ratio (two graphs, a
 * control, a solo cross-check). It is the wrong shape to hang `--cpu-prof`,
 * `--trace-deopt` or `--trace-gc` off: those instruments are process-global, so
 * a two-leg process attributes the head leg's deopts and the reference leg's
 * deopts to the same log.
 *
 * This builds exactly ONE leg — the head `macro→emitted` side or the reference
 * `macro→source` side — parses one fixture N times, and gets out of the way. It
 * prints a millisecond so the profiled run can be checked against `ab.ts`'s
 * figure, but the millisecond is NOT the deliverable: a one-leg process has no
 * control and is not quotable as a ratio.
 *
 *   node --import ./bench/jess/ab-register.mjs bench/jess/emit-profile.ts \
 *     --side=head --dialect=css --n=40
 *
 * `--side=ref` materialises the reference from ab-config.json (or `--ref=<sha>`)
 * and builds an `r1` leg. `--pieces` reports V8's optimisation verdict on the
 * emitted pieces, and needs `--allow-natives-syntax`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialise, median } from '../ab-harness.ts'
import { ENTRY, JESS_ROOT, VARIANT_SETTINGS, exportName, headSha, loads, type Dialect } from './grammars.ts'
import { run } from '../../src/functional/run.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const CONFIG = JSON.parse(readFileSync(path.join(HERE, 'ab-config.json'), 'utf8')) as { referenceSha: string }

const arg = (flag: string): string | null =>
  process.argv.find(a => a.startsWith(`--${flag}=`))?.slice(flag.length + 3) ?? null

const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}
const FIXTURE: Record<Dialect, string> = {
  css: 'packages/jess/benchmark/benchmark.css',
  less: 'packages/jess/benchmark/benchmark.less',
  scss: 'packages/jess/benchmark/gen-workload.scss',
  jess: 'packages/jess/benchmark/benchmark.jess',
}

type Entry = Parameters<typeof run>[0]
type Runner = (entry: Entry, input: string) => ReturnType<typeof run>

/** See its call site: the frame `--cpu-prof` output is cut at. */
function __PM_WARM_MARK__(): number {
  let x = 0
  const t0 = performance.now()
  while (performance.now() - t0 < 30) x += Math.sqrt(x + 1)
  return x
}

async function main(): Promise<void> {
  const side = arg('side') ?? 'head'
  const dialect = (arg('dialect') ?? 'css') as Dialect
  const n = Number(arg('n') ?? '40')
  const fixtureRel = arg('fixture') ?? FIXTURE[dialect]
  const engine = arg('engine') ?? 'macro'

  let src = path.join(ROOT, 'src')
  let legSide = 'h1'
  let label = `HEAD ${headSha()}`
  if (side === 'ref') {
    const ref = arg('ref') ?? CONFIG.referenceSha
    const refDir = materialise('jess-ab', ROOT, ref, [])
    src = path.join(refDir, 'src')
    mkdirSync(path.join(ROOT, '.cache'), { recursive: true })
    writeFileSync(path.join(ROOT, '.cache', 'jess-ab-refsrc'), src)
    legSide = 'r1'
    label = `REF ${ref}`
  }

  // `--dump=<file>` captures the EMITTED ASSEMBLY TEXT. `assemble.ts:2536` builds
  // it with `new Function(...EMITTED_PARAMS, source)`, so intercepting the global
  // constructor gets the source without touching src/. Counting constructs in
  // that text is an emit-time fact and beats any sampled figure for questions of
  // the form "does the emitter believe X at every site".
  const dump = arg('dump')
  if (dump !== null) {
    const Real = globalThis.Function
    const sources: string[] = []
    const Patched = function (this: unknown, ...a: string[]): unknown {
      if (a.length > 20) sources.push(a[a.length - 1]!)
      return Reflect.construct(Real, a, Patched as unknown as new () => unknown)
    }
    Patched.prototype = Real.prototype
    ;(globalThis as { Function: unknown }).Function = Patched
    process.on('exit', () => {
      writeFileSync(dump, sources.join('\n/* ---- next factory ---- */\n'))
      console.log(`  dumped ${sources.length} factory source(s), ${sources.reduce((s, x) => s + x.length, 0)} B -> ${dump}`)
    })
  }

  const grammarPath = path.resolve(JESS_ROOT, MODULE[dialect])
  const name = exportName(dialect, 'ast')
  const { run: runner } = await import(`pm-side:${legSide}:${path.join(src, 'functional/run.ts')}`) as { run: Runner }
  const lowering = existsSync(path.join(src, 'compiler', 'codegen.ts')) ? 'macro→source' : 'macro→emitted'

  let entry: Entry
  if (engine === 'macro') {
    const mod = await import(`pm-side:${legSide}:macro:${grammarPath}`) as Record<string, Record<string, unknown>>
    entry = mod[name]?.[ENTRY] as Entry
    if (typeof entry !== 'function') throw new Error('macro did not produce a function')
  } else {
    const mod = await import(`pm-side:${legSide}:${grammarPath}`) as Record<string, Record<string, unknown>>
    const grammar = mod[name]!
    const rules: Record<string, unknown> = {}
    for (const k of Object.keys(grammar)) rules[k] = grammar[k]
    if (engine === 'interpreter') entry = rules[ENTRY] as Entry
    else {
      const enc = await import(`pm-side:${legSide}:${path.join(src, 'table/encode.ts')}`) as { encodeTable: (r: Record<string, unknown>, s: unknown) => unknown }
      const ex = await import(`pm-side:${legSide}:${path.join(src, 'table/exec.ts')}`) as { tableRules: (t: unknown) => Record<string, unknown> }
      entry = ex.tableRules(enc.encodeTable(rules, VARIANT_SETTINGS.ast))[ENTRY] as Entry
    }
  }

  const input = readFileSync(path.resolve(JESS_ROOT, fixtureRel), 'utf8')
  const bytes = Buffer.byteLength(input)
  const shape = typeof entry === 'function'
    ? `fn ${(entry as unknown as { name: string }).name || '(anon)'} ${String(entry).length} B`
    : `obj keys=${Object.keys(entry as object).length}`

  console.log(`emit-profile  ${label}  ${dialect}  ${engine}/${lowering}`)
  console.log(`  src     ${src}`)
  console.log(`  entry   ${shape}`)
  console.log(`  fixture ${fixtureRel}  ${bytes} B   n=${n}`)
  console.log(`  node ${process.version}  loadavg ${loads()}  cpus ${os.cpus().length}`)

  const once = (): void => { runner(entry, input) }
  const r0 = runner(entry, input) as unknown as { ok?: boolean; span?: { end?: number } }
  console.log(`  parse   ok=${r0.ok === true} consumed=${r0.span?.end ?? 0}/${bytes}`)

  for (let i = 0; i < 5; i++) once()
  if (process.env.PM_MARK === '1') console.log('### WARM ###')
  // A frame the CPU profile can be CUT AT. `--cpu-prof` covers the whole
  // process, and on these fixtures compile+warmup is a comparable slice of it to
  // the steady state — profiling both together attributes one-time emission cost
  // to the parse. This burns long enough to be sampled with certainty, and every
  // sample before its last one is dropped when the profile is reduced.
  __PM_WARM_MARK__()
  const ts: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    once()
    ts.push(performance.now() - t0)
  }
  ts.sort((a, b) => a - b)
  console.log(`  median  ${median(ts).toFixed(3)} ms   min ${ts[0]!.toFixed(3)}   max ${ts[ts.length - 1]!.toFixed(3)}`)
  console.log(`  loadavg at end ${loads()}`)
}

await main()
