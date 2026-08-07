/**
 * ONE cold load measurement, in its own process, as one JSON line.
 *
 * FRESH PROCESS PER MEASUREMENT is the whole point: node's module cache and
 * V8's compilation cache both make a second import of the same module measure
 * nothing. `load.ts` spawns one of these per (dialect, lowering, phase).
 *
 * The two phases answer two different questions:
 *
 *   compile  V8's parse+compile cost for the artifact SOURCE, with `vm.Script`
 *            and imports stripped. This is the pure form of the claim: a
 *            multi-megabyte codegen module is JAVASCRIPT V8 must compile, a
 *            table module is a numeric literal it must not. Run twice by the
 *            driver — once normally (V8 compiles function bodies LAZILY) and
 *            once under `--no-lazy` (everything compiled eagerly up front).
 *            The gap between those two is the cost codegen DEFERS rather than
 *            avoids, and it is charged on first call instead.
 *
 *   import   real `import()` of a real on-disk `.mjs`, from just before the
 *            import to the entry rule being callable. Includes the artifact's
 *            own dependency loads, which is what a consumer actually pays.
 *
 * BOTH ARTIFACTS ARE MADE STANDALONE AND FAIR. The lowered codegen module's only
 * runtime imports are `@jesscss/core/ast` (plus less's `./parse-error.js`) — the
 * macro inlines the recognition pieces, so a shipped codegen grammar has NO
 * parseman runtime dependency at all. The table module's is `parseman/table`.
 * Each is rewritten to an absolute path so neither needs a `node_modules`.
 *
 * The table artifact additionally gets the SAME `@jesscss/core/ast` import the
 * macro-lowered one carries. Its reducers reference those bindings as free
 * variables, so omitting it would let the table skip a dependency load its real
 * build pays — an asymmetry worth several milliseconds, all of it in the table's
 * favour.
 *
 * ENGINE TOKEN LEGEND — the `LOWERINGS` tokens are a WIRE CONTRACT (`load.ts`
 * passes them positionally) and keep their historical spelling; this is what
 * each one actually binds:
 *   codegen   transformMacro() / `pm-macro:`   the shipped ASSEMBLER. There is
 *                                              no source-lowering engine:
 *                                              `src/compiler/codegen.ts` was
 *                                              DELETED in `37c57b5`.
 *   table     execRules()                      the REFERENCE bytecode
 *                                              interpreter (NOT what ships)
 * The `parse` phase's emitted JSON keys were renamed to match the engines:
 * `codegenMs` -> `assembledMs`, `tableMs` -> `execMs`.
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import vm from 'node:vm'
import { encodeTable } from '../../src/table/encode.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import {
  DIALECTS, ENTRY, JESS_ROOT, VARIANT_SETTINGS,
  assertParseman, exportName, loadGrammar, type Dialect,
} from './grammars.ts'

export const LOWERINGS = ['codegen', 'table'] as const
export type Lowering = (typeof LOWERINGS)[number]
export const PHASES = ['compile', 'import', 'parse'] as const
export type Phase = (typeof PHASES)[number]

/**
 * The fixture the `parse` phase measures per-byte parse cost on — the largest
 * real one each dialect has, so the rate is a throughput rate and not dominated
 * by per-call fixed cost. The crossover is only as good as this input, so it is
 * a named repo file rather than a synthesised string.
 */
export const RATE_FIXTURE: Record<Dialect, string> = {
  css: 'packages/jess/benchmark/benchmark.css',
  less: 'packages/jess/benchmark/gen-workload.less',
  scss: 'packages/jess/benchmark/gen-workload.scss',
  jess: 'packages/jess/benchmark/chunk.jess',
}

const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}

const OUT = '/tmp/pm-load'
/** The built driver a table artifact imports — the real shipped file. */
const DRIVER_DIST = 'dist/table/index.js'

export type LoadRow = {
  dialect: Dialect
  lowering: Lowering
  phase: Phase
  lazy: boolean
  /** Bytes of JavaScript V8 is handed. */
  jsBytes: number
  /** Median ms over `reps`. */
  ms: number
  samples: number[]
  file: string
}

const median = (a: readonly number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** The lowered artifact as JavaScript, plus the imports it really needs. */
async function artifact(dialect: Dialect, lowering: Lowering): Promise<{ js: string; imports: string }> {
  const file = resolvePath(JESS_ROOT, MODULE[dialect])
  const req = createRequire(file)
  const astPath = req.resolve('@jesscss/core/ast')
  const { transformSync } = await import('esbuild')

  if (lowering === 'codegen') {
    const { transformMacro } = await import('../../src/plugin/index.ts')
    const out = transformMacro(readFileSync(file, 'utf8'), file, new Set(['parseman']))
    const code = typeof out === 'string' ? out : out?.code
    if (!code) throw new Error(`macro lowering produced nothing for ${dialect}`)
    let js = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: file }).code
    // Absolute paths so the artifact needs no `node_modules` of its own.
    js = js.replace(/(from\s*["'])@jesscss\/core\/ast(["'])/g, `$1${pathToFileURL(astPath).href}$2`)
    // Point at the BUILT `lib/parse-error.js`, not `src/parse-error.ts`. The TS
    // source would be transpiled by `hooks.mjs` on the way in, charging less's
    // codegen side an esbuild run that no consumer of a built artifact pays —
    // several ms, all of it against codegen, in a comparison this harness is
    // trying to keep honest. Only less has this import.
    const built = resolvePath(file, '../../lib/parse-error.js')
    js = js.replace(/(from\s*["'])\.\/parse-error\.js(["'])/g, `$1${pathToFileURL(built).href}$2`)
    return { js, imports: '' }
  }

  const { rules } = await loadGrammar(dialect, 'ast')
  const prog = encodeTable(rules, VARIANT_SETTINGS.ast)
  const driver = pathToFileURL(resolvePath(process.cwd(), DRIVER_DIST)).href
  const mod = emitTableModule(prog, { name: exportName(dialect, 'ast'), fnSources: prog.fns.map(f => String(f)), runtime: driver })
  // The reducers reference `@jesscss/core/ast` bindings as free variables. A
  // real build emits that import; adding it here is what keeps the two sides
  // paying for the same dependency graph.
  const astImport = `import * as __ast from ${JSON.stringify(pathToFileURL(astPath).href)}\nglobalThis.__ast = __ast\n`
  return { js: astImport + mod, imports: astImport }
}

/**
 * Strip module syntax so `vm.Script` will accept the body.
 *
 * Compilation does not need identifiers to resolve, so deleting imports changes
 * nothing this measures. Done line-wise rather than with one regex because the
 * codegen artifact's `@jesscss/core/ast` import spans 30-odd lines, and a
 * single-line pattern silently left it in — `vm.Script` then threw
 * "Cannot use import statement outside a module" and the codegen side could not
 * be measured at all.
 *
 * Lines are BLANKED, not removed, so both sides keep their line numbering and
 * neither gets an accidental lexing advantage from a shorter file.
 */
function scriptable(js: string): string {
  const lines = js.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trimStart()
    if (!t.startsWith('import ') && !t.startsWith('import{') && !t.startsWith('export {')) continue
    // `export { ... }` is multi-line too — esbuild emits one name per line at
    // the foot of the codegen artifact. Blanking only the opening line left a
    // stray `};` and `vm.Script` threw on it.
    if (t.startsWith('export {')) {
      for (; i < lines.length; i++) {
        const done = lines[i]!.includes('}')
        lines[i] = ''
        if (done) break
      }
      continue
    }
    // Single-line form: `import ... from '...'` or a bare `import '...'`.
    if (/from\s*["'][^"']+["'];?\s*$/.test(t) || /^import\s*["'][^"']+["'];?\s*$/.test(t)) { lines[i] = ''; continue }
    // Multi-line form: blank through the line that closes it.
    for (; i < lines.length; i++) {
      const done = /from\s*["'][^"']+["'];?\s*$/.test(lines[i]!.trimEnd())
      lines[i] = ''
      if (done) break
    }
  }
  return lines.join('\n').replace(/^\s*export\s+(?=(?:const|let|var|function|class)\b)/gm, '')
}

async function main(): Promise<void> {
  const dialect = process.argv[2] as Dialect
  const lowering = process.argv[3] as Lowering
  const phase = process.argv[4] as Phase
  const reps = Number(process.argv[5] ?? 5)
  if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${String(process.argv[2])}'`)
  if (!LOWERINGS.includes(lowering)) throw new Error(`unknown lowering '${String(process.argv[3])}'`)
  if (!PHASES.includes(phase)) throw new Error(`unknown phase '${String(process.argv[4])}'`)
  const pm = await assertParseman()

  mkdirSync(OUT, { recursive: true })
  const { js } = await artifact(dialect, lowering)
  const file = resolvePath(OUT, `${dialect}.${lowering}.mjs`)
  writeFileSync(file, js)
  const jsBytes = Buffer.byteLength(js)
  const lazy = !process.execArgv.includes('--no-lazy')

  const samples: number[] = []
  if (phase === 'compile') {
    const src = scriptable(js)
    for (let n = 0; n < reps; n++) {
      // A UNIQUE source every time. A fresh `vm.Script` over the SAME text is
      // not a cold compile: V8's compilation cache is keyed on the source, and
      // the first measured 0.79 ms against 0.010 ms for every rep after it. The
      // trailing comment defeats that cache; it costs one line of lexing.
      const unique = `${src}\n//${n}`
      const t0 = performance.now()
      new vm.Script(unique, { filename: `${dialect}.${lowering}.${n}.js` })
      samples.push(performance.now() - t0)
    }
  } else if (phase === 'parse') {
    // BOTH lowerings, in ONE process, INTERLEAVED — the `lowering` argument is
    // ignored here on purpose. The crossover's slope is a DIFFERENCE between the
    // two parse rates, and measuring the two sides in separate processes is
    // exactly the comparison `bench/ab-harness.ts` exists to forbid: the same
    // case read 9.4 ms and 26 ms across consecutive launches on this hardware.
    // Measured that way the jess crossover moved 1.59 -> 2.08 MB between runs;
    // interleaved it is stable.
    //
    // Both engines are built from the live grammar — the on-disk artifacts
    // cannot parse (the table's reducer sources are recovered from closures and
    // have lost their captured scope), and this phase needs a working parser.
    const { run } = await import('../../src/functional/run.ts')
    const { execRules } = await import('../../src/table/exec.ts')
    const { interleave } = await import('../ab-harness.ts')
    const { rules } = await loadGrammar(dialect, 'ast')
    const input = readFileSync(resolvePath(JESS_ROOT, RATE_FIXTURE[dialect]), 'utf8')
    type E = Parameters<typeof run>[0]
    const table = execRules(encodeTable(rules, VARIANT_SETTINGS.ast))[ENTRY] as E
    const codegen = ((await import(`pm-macro:${resolvePath(JESS_ROOT, MODULE[dialect])}`) as Record<string, unknown>)[exportName(dialect, 'ast')] as Record<string, unknown>)[ENTRY] as E
    if (typeof codegen !== 'function') throw new Error(`${dialect}: 'codegen' is not a function — the macro did not run`)
    const mk = (e: E) => [{
      id: dialect, detail: '',
      parse: () => { run(e, input) },
      run: (r: number) => { for (let n = 0; n < r; n++) run(e, input) },
    }]
    const out = interleave(
      [{ label: 'p', a: mk(codegen), b: mk(table) }],
      new Map([[dialect, 1]]),
      { targetSampleMs: 0, warmup: 3, timed: 5, rounds: 6, runs: 2 },
    )
    const s = out.get('p')!
    const bytes = Buffer.byteLength(input)
    process.stdout.write(JSON.stringify({
      dialect, phase, lazy, jsBytes: bytes, file: RATE_FIXTURE[dialect],
      assembledMs: median(s.get(`ref|${dialect}`)!),
      execMs: median(s.get(`head|${dialect}`)!),
      parseman: pm.version,
    }) + '\n')
    return
  } else {
    // ONE import, and one only — the second is a cache hit and measures nothing.
    // That is why `reps` is spent on processes by the driver, not on iterations.
    const t0 = performance.now()
    const m = await import(pathToFileURL(file).href) as Record<string, unknown>
    const g = m[exportName(dialect, 'ast')] as Record<string, unknown> | undefined
    if (g === undefined) throw new Error(`${dialect}/${lowering}: artifact exposed no ${exportName(dialect, 'ast')}`)
    const entry = g[ENTRY]
    if (entry === undefined) throw new Error(`${dialect}/${lowering}: no rule '${ENTRY}' — not parser-callable`)
    samples.push(performance.now() - t0)
  }

  const row: LoadRow = { dialect, lowering, phase, lazy, jsBytes, ms: median(samples), samples, file }
  process.stdout.write(JSON.stringify({ ...row, parseman: pm.version }) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
