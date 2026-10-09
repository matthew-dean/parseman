/**
 * REAL-GRAMMAR LOAD GATE — docs/design/runtime-and-size-contract.md, rule 5.
 *
 * No benchmark measured grammar LOAD at real scale, which is how a 2.4 s runtime
 * `compose()` for Less went unseen. This one measures jess's four grammars (the
 * vendored snapshot, `bench/jess/real-grammars.ts`), each in fresh processes,
 * median of `RUNS`:
 *
 *   macro        import of the compiled CST variant, and its first parse
 *   interpreter  import of the interpreter CST grammar — its `rules()` pieces and
 *                runtime `compose()` over css's base — and its first parse, which
 *                is when the lazy link runs
 *   compile      `compile()` of that interpreter grammar, and a first parse
 *   compile CSP  the same under `--disallow-code-generation-from-strings`: the
 *                closure fallback
 *
 * Every row has an ABSOLUTE budget in `bench/jess-grammar-load-budgets.json`. A row
 * over its budget, a parse that fails, or a missing row exits 1. The budgets are
 * wall-clock milliseconds with deliberate headroom for CI hardware: they catch a
 * regression of the 2.4 s kind, not a few percent.
 *
 *   pnpm load:guard:jess            (--record prints measured rows as budget JSON)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DIALECTS, withBuiltSnapshot, type Dialect } from './jess/real-grammars.ts'

const PROBE = resolve(import.meta.dirname, 'jess/real-load-probe.mjs')
const BUDGETS = resolve(import.meta.dirname, 'jess-grammar-load-budgets.json')
const RUNS = Number(process.env.LOAD_GUARD_RUNS ?? 5)

type Probe = { import: number; firstParse?: number; ok?: boolean; compile?: number; compiledFirstParse?: number; compiledOk?: boolean }
export type LoadRow = { dialect: Dialect; measure: string; ms: number; ok: boolean }

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]!
}

function probe(bundle: string, mode: 'cst' | 'ast', compile: boolean, csp: boolean): Probe {
  const args = [...(csp ? ['--disallow-code-generation-from-strings'] : []), PROBE, bundle, mode, compile ? 'compile' : '']
  return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000 })) as Probe
}

export async function measureLoad(): Promise<LoadRow[]> {
  return withBuiltSnapshot(async snap => {
    const rows: LoadRow[] = []
    for (const dialect of DIALECTS) {
      const macro = await snap.runnable(dialect, 'cst')
      const interp = await snap.interpreter(dialect, 'cst')
      const m = Array.from({ length: RUNS }, () => probe(macro, 'cst', false, false))
      const i = Array.from({ length: RUNS }, () => probe(interp, 'cst', true, false))
      const c = Array.from({ length: RUNS }, () => probe(interp, 'cst', true, true))
      const all = (ps: Probe[], key: 'ok' | 'compiledOk'): boolean => ps.every(p => p[key] === true)
      rows.push(
        { dialect, measure: 'macro import', ms: median(m.map(p => p.import)), ok: true },
        { dialect, measure: 'macro first parse', ms: median(m.map(p => p.firstParse!)), ok: all(m, 'ok') },
        { dialect, measure: 'interpreter import (compose)', ms: median(i.map(p => p.import)), ok: true },
        { dialect, measure: 'interpreter first parse (link)', ms: median(i.map(p => p.firstParse!)), ok: all(i, 'ok') },
        { dialect, measure: 'compile()', ms: median(i.map(p => p.compile!)), ok: all(i, 'compiledOk') },
        { dialect, measure: 'compile() under CSP', ms: median(c.map(p => p.compile!)), ok: all(c, 'compiledOk') },
      )
    }
    return rows
  })
}

export function loadFailures(rows: readonly LoadRow[], budgets: Readonly<Record<string, number>>): string[] {
  const failures: string[] = []
  for (const r of rows) {
    const key = `${r.dialect} ${r.measure}`
    const budget = budgets[key]
    if (!r.ok) failures.push(`${key}: the parse failed`)
    if (budget === undefined) failures.push(`${key}: no budget recorded`)
    else if (r.ms > budget) failures.push(`${key}: ${r.ms.toFixed(1)} ms is over its ${budget} ms budget`)
  }
  for (const key of Object.keys(budgets)) {
    if (!rows.some(r => `${r.dialect} ${r.measure}` === key)) failures.push(`${key}: budgeted but not measured`)
  }
  return failures
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await measureLoad()
  const budgets = JSON.parse(readFileSync(BUDGETS, 'utf8')) as { budgets: Record<string, number> }
  console.log(`load-guard:jess  median of ${RUNS} fresh processes, absolute budgets from ${join('bench', 'jess-grammar-load-budgets.json')}`)
  for (const r of rows) {
    const key = `${r.dialect} ${r.measure}`
    console.log(`  ${key.padEnd(40)} ${r.ms.toFixed(1).padStart(8)} ms  budget ${String(budgets.budgets[key] ?? '—').padStart(6)}${r.ok ? '' : '  PARSE FAILED'}`)
  }
  if (process.argv.includes('--record')) {
    console.log(JSON.stringify(Object.fromEntries(rows.map(r => [`${r.dialect} ${r.measure}`, Number(r.ms.toFixed(1))])), null, 2))
  }
  const failures = loadFailures(rows, budgets.budgets)
  if (failures.length > 0) {
    console.error(`load-guard:jess: FAILED\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`load-guard:jess: ok — ${rows.length} rows within budget`)
}
