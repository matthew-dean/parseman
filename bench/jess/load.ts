/**
 * LOAD / JS-INTERPRETATION cost, reference interpreter vs macro lowering — the
 * other side of the ledger.
 *
 * ENGINE TOKEN LEGEND — the `LOWERINGS` tokens (`load-one.ts`) and the `${d}|…`
 * map keys below are a WIRE CONTRACT and keep their historical spelling; this is
 * what each one actually binds:
 *   codegen   transformMacro() / `pm-macro:`   the shipped ASSEMBLER. There is
 *                                              no source-lowering engine:
 *                                              `src/compiler/codegen.ts` was
 *                                              DELETED in `37c57b5`.
 *   table     execRules()                      the REFERENCE bytecode
 *                                              interpreter (NOT what ships)
 * The figures from this harness published in `CHANGELOG.md` were taken under the
 * OLD names — `codegen` for what the columns now call `assembled`, and `table`
 * for what they now call `exec`.
 *
 * The parse-speed result says the reference interpreter is 2-4x slower per byte.
 * That is only half the trade: a macro-lowered grammar is MEGABYTES OF
 * JAVASCRIPT that V8 must parse and compile before anything runs, and a table is
 * a numeric literal it must not. This measures both halves in the same units and
 * reports where they cross.
 *
 * Every measurement is a FRESH PROCESS. Node's module cache and V8's compilation
 * cache each make a second measurement of the same thing meaningless, and this
 * harness measured 0.79 ms then 0.010 ms for the identical compile before that
 * was handled.
 *
 * Three phases, three different claims:
 *   compile   V8 parse+compile of the artifact source (`vm.Script`). Run BOTH
 *             lazily (V8's default: function bodies are compiled on first call)
 *             and under `--no-lazy`. The gap is what the macro lowering DEFERS,
 *             not what it avoids — it is paid on first call instead, and a
 *             parser's functions are all called.
 *   import    real `import()` to parser-callable, including dependency loads.
 *             This is what a consumer pays and is the number the crossover uses.
 *   parse     per-byte parse cost on the dialect's largest real fixture, so the
 *             crossover has a MEASURED slope.
 *
 * THE DRIVER IS COUNTED. A table artifact imports `parseman/table`; its real
 * built file (`dist/table/index.js`) is loaded as part of the table's `import`
 * phase, so its cost is inside the table's number, not hidden. The macro-lowered
 * artifact imports NO parseman runtime at all — the macro inlines the
 * recognition pieces — which is a genuine advantage for that side and is stated
 * as one. Both sides import `@jesscss/core/ast`.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/load.ts`
 */
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIALECTS, assertParseman, type Dialect } from './grammars.ts'
import { LOWERINGS, RATE_FIXTURE, type Lowering, type LoadRow } from './load-one.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTER = resolvePath(HERE, 'register.mjs')
const ONE = resolvePath(HERE, 'load-one.ts')
const DRIVER_DIST = 'dist/table/index.js'

/** How many fresh PROCESSES per `import` measurement — one import each, and the
 * median across processes is the number. */
const IMPORT_PROCS = 5

function one(dialect: Dialect, lowering: Lowering, phase: string, reps: number, eager = false): LoadRow {
  const out = execFileSync(
    process.execPath,
    [...(eager ? ['--no-lazy'] : []), '--import', REGISTER, ONE, dialect, lowering, phase, String(reps)],
    { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, PM_MACRO: '' } },
  )
  return JSON.parse(out.trim().split('\n').at(-1)!) as LoadRow
}

type Rates = { assembledMs: number; execMs: number; jsBytes: number }

/** Both parse rates from ONE interleaved process. `lowering` is ignored by that
 * phase; `table` is passed only because the argument is positional. */
function parseRates(dialect: Dialect): Rates {
  const out = execFileSync(
    process.execPath,
    ['--import', REGISTER, ONE, dialect, 'table', 'parse', '1'],
    { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, PM_MACRO: '' } },
  )
  return JSON.parse(out.trim().split('\n').at(-1)!) as Rates
}

const median = (a: readonly number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const kb = (n: number): string => (n / 1024).toFixed(0)

async function main(): Promise<void> {
  const pm = await assertParseman()
  console.log(`parseman ${pm.version}   ${pm.root}   node ${process.version}`)
  console.log(`cpus ${os.cpus().length}   loadavg at START ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
  const startLoad = os.loadavg()[0]!
  if (startLoad > 6 && process.env.PM_FORCE !== '1') {
    console.error(`\nDEFERRED: 1-minute load average is ${startLoad.toFixed(2)}, over the 6 ceiling.`)
    console.error('Nothing measured on a box this busy is a result. Re-run when it settles, or PM_FORCE=1.')
    process.exit(2)
  }
  console.log(`driver ${DRIVER_DIST} = ${statSync(resolvePath(HERE, '../..', DRIVER_DIST)).size} B, loaded once per process by the TABLE side only`)
  console.log('')

  type Cell = { compileLazy: number; compileEager: number; imp: number; parse: number; js: number }
  const data = new Map<string, Cell>()
  const rateBytes = new Map<Dialect, number>()

  for (const d of DIALECTS) {
    for (const l of LOWERINGS) {
      const cl = one(d, l, 'compile', 5)
      const ce = one(d, l, 'compile', 5, true)
      const imps: number[] = []
      for (let n = 0; n < IMPORT_PROCS; n++) imps.push(one(d, l, 'import', 1).ms)
      data.set(`${d}|${l}`, { compileLazy: cl.ms, compileEager: ce.ms, imp: median(imps), parse: 0, js: cl.jsBytes })
    }
    // ONE interleaved process gives BOTH parse rates; see `load-one.ts`'s
    // `parse` phase for why they cannot be measured in separate ones.
    const pr = parseRates(d)
    data.get(`${d}|codegen`)!.parse = pr.assembledMs
    data.get(`${d}|table`)!.parse = pr.execMs
    rateBytes.set(d, pr.jsBytes)
  }

  console.log('=== V8 COMPILE COST of the artifact source (vm.Script, fresh source each rep)')
  console.log('           |------------ assembled ------------|  |-------------- exec -------------|   lazy')
  console.log('            JS KB    lazy ms   eager ms  deferred   JS KB   lazy ms  eager ms  deferred   ratio')
  for (const d of DIALECTS) {
    const c = data.get(`${d}|codegen`)!
    const t = data.get(`${d}|table`)!
    console.log(
      `  ${d.padEnd(6)} ${kb(c.js).padStart(7)} ${c.compileLazy.toFixed(1).padStart(10)} ${c.compileEager.toFixed(1).padStart(10)} ${(c.compileEager - c.compileLazy).toFixed(1).padStart(9)}`
      + ` ${kb(t.js).padStart(8)} ${t.compileLazy.toFixed(2).padStart(9)} ${t.compileEager.toFixed(2).padStart(9)} ${(t.compileEager - t.compileLazy).toFixed(2).padStart(9)}`
      + ` ${(c.compileLazy / t.compileLazy).toFixed(0).padStart(6)}x`,
    )
  }
  console.log('    "deferred" is eager minus lazy: work V8 postpones to first call, not work avoided.')
  console.log('    A parser calls every one of its rule functions, so the assembled side pays it in full.')
  console.log('')

  console.log('=== COLD IMPORT to parser-callable (fresh process each, median of ' + String(IMPORT_PROCS) + ')')
  console.log('         assembled ms     exec ms    exec saves   ratio')
  for (const d of DIALECTS) {
    const c = data.get(`${d}|codegen`)!
    const t = data.get(`${d}|table`)!
    console.log(
      `  ${d.padEnd(6)} ${c.imp.toFixed(1).padStart(10)} ${t.imp.toFixed(1).padStart(11)} ${(c.imp - t.imp).toFixed(1).padStart(13)} ${(c.imp / t.imp).toFixed(1).padStart(7)}x`,
    )
  }
  console.log('    EXEC side includes loading the shared driver; ASSEMBLED side imports no parseman at all.')
  console.log('')

  console.log('=== CROSSOVER — how much input the assembled side must parse to repay its load cost')
  console.log('    Total(B) = load + B * per-byte parse cost. Solve for equality.')
  console.log('')
  console.log('           load delta   parse rate delta      crossover      crossover')
  console.log('              (ms)        (ms per MB)          (MB)          vs fixture')
  for (const d of DIALECTS) {
    const c = data.get(`${d}|codegen`)!
    const t = data.get(`${d}|table`)!
    const fixtureBytes = rateBytes.get(d)!
    // ms per byte on each side, from the measured single-parse median.
    const perByteC = c.parse / fixtureBytes
    const perByteT = t.parse / fixtureBytes
    const loadDelta = c.imp - t.imp
    const rateDelta = perByteT - perByteC
    const crossBytes = loadDelta / rateDelta
    console.log(
      `  ${d.padEnd(6)} ${loadDelta.toFixed(1).padStart(10)} ${(rateDelta * 1e6).toFixed(1).padStart(18)} ${(crossBytes / 1e6).toFixed(2).padStart(14)} ${(crossBytes / fixtureBytes).toFixed(1).padStart(13)}x`,
    )
  }
  console.log('')
  console.log(`    Rate fixtures: ${DIALECTS.map(d => `${d}=${RATE_FIXTURE[d].split('/').pop()!}`).join(', ')}`)
  console.log('    BELOW the crossover the exec side is ahead overall; ABOVE it the assembled side is.')
  console.log('    Read it as: exec wins whenever a process parses less than this much input.')
  console.log('')
  console.log(`loadavg at END ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
}

await main()
