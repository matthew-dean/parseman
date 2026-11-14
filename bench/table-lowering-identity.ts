/**
 * Correctness gate: every table engine must produce the SAME result as the
 * interpreter for a grammar's whole corpus.
 *
 * Oracle is `parseman/oracle`'s `digestValue` — the repo's byte-identity
 * primitive — applied to the `run()` result of each path over one input:
 *
 *   interpreted   the combinator graph                         (semantic reference)
 *   compiled      tableRules({ ...prog, asm: [] })             (closures only: the shape a macro
 *                                                              build ships with no selected sites;
 *                                                              not compileRuleMap()'s own output)
 *   table         encodeTable() + tableRules()                 (the shipped engine, emitted where it can)
 *   reference     encodeTable() + execRules()                  (the reference driver)
 */
import { digestValue } from '../src/oracle/index.ts'
import { run, type Runnable } from '../src/functional/run.ts'
import { encodeTable, type TableSettings } from '../src/table/encode.ts'
/**
 * `tableRules` IS THE SHIPPED TABLE ENGINE — `src/table/index.ts` re-exports
 * it under the name `tableRules`, and `compile`/`compileRuleMap` build
 * through it. This sweep imported a same-named export from `src/table/exec.ts`
 * instead, which is the REFERENCE driver: every case here, and every case in the
 * CI subset (`test/unit/table-identity.test.ts`), gated a driver nothing ships
 * while the assembler went unexecuted.
 *
 * Both legs run now. `assembled` is the one under gate; `reference` stays because
 * `exec.ts` is what an assembler divergence gets bisected against, and losing it
 * would trade one blind spot for another.
 */
import { tableRules } from '../src/table/assemble.ts'
import { execRules as referenceRules } from '../src/table/exec.ts'
import type { Combinator } from '../src/types.ts'

export type Paths = {
  interpreted: Record<string, Combinator<unknown>>
  compiled: Record<string, (input: string, pos: number, ctx: never) => unknown>
  table: ReturnType<typeof tableRules>
}

/** Build the shipped table path for one rule map + settings pair. */
export function buildPaths(
  ruleMap: Record<string, Combinator<unknown>>,
  settings: TableSettings = {},
): { table: ReturnType<typeof tableRules>; compiledSource: string } {
  const prog = encodeTable(ruleMap, settings)
  return { table: tableRules(prog), compiledSource: '' }
}

export type IdentityCase = { name: string; input: string }

export type IdentityReport = {
  total: number
  matched: number
  mismatches: Array<{ case: string; path: string; a: string; b: string }>
}

type RunnableLike = Runnable

function digestRun(entry: RunnableLike, input: string, trivia?: RunnableLike, rootTrivia?: readonly string[]): string {
  const r = run(entry, input, {
    ...(trivia === undefined ? {} : { trivia }),
    ...(rootTrivia === undefined ? {} : { rootTrivia: { select: [...rootTrivia] } }),
  })
  // Digest the OUTCOME, not just the value: everything a caller of `run()` can read.
  // FAILURE IS PART OF THE OUTPUT. Digesting only { ok, value, unconsumedFrom }
  // made every divergence in HOW a parse fails invisible to every sweep — a
  // table could report the wrong expected set, or none at all, and agree.
  // `expected` is sorted because neither engine promises an order and an
  // ordering difference is not a semantic one.
  return digestValue({
    ok: r.ok,
    value: r.value,
    span: r.span,
    unconsumedFrom: r.unconsumedFrom,
    errors: r.errors,
    expected: r.ok ? undefined : [...(r.expected ?? [])].sort(),
    rootTrivia: r.rootTrivia?.rows,
  })
}

export function checkIdentity(
  ruleMap: Record<string, Combinator<unknown>>,
  entryRule: string,
  cases: readonly IdentityCase[],
  opts: {
    settings?: TableSettings
    trivia?: Combinator<unknown>
    /**
     * Gate against the INTERPRETER only: skip the closure-artifact leg. Callers
     * must say which they got.
     */
    interpreterOnly?: boolean
    /** Trivia kinds to ask `run()` to report: root trivia reaches the digest only when asked for. */
    rootTrivia?: readonly string[]
  } = {},
): IdentityReport {
  const settings = opts.settings ?? {}
  const interp = ruleMap[entryRule]
  if (interp === undefined) throw new Error(`no rule '${entryRule}'`)

  const prog = encodeTable(ruleMap, settings)
  const tbl = tableRules(prog)[entryRule]
  if (tbl === undefined) throw new Error(`table has no rule '${entryRule}'`)
  const ref = referenceRules(prog)[entryRule]
  if (ref === undefined) throw new Error(`reference table has no rule '${entryRule}'`)

  // The canonical closure artifact macro output runs (`a:[]`: no specialisation).
  const compiledMap = opts.interpreterOnly
    ? undefined
    : tableRules({ ...prog, asm: [] }) as unknown as Record<string, RunnableLike>
  const comp = compiledMap?.[entryRule]
  if (comp === undefined && !opts.interpreterOnly) throw new Error(`compiled map has no rule '${entryRule}'`)

  const report: IdentityReport = { total: 0, matched: 0, mismatches: [] }
  for (const c of cases) {
    report.total++
    const di = digestRun(interp as RunnableLike, c.input, opts.trivia as RunnableLike | undefined, opts.rootTrivia)
    const dc = comp === undefined ? undefined : digestRun(comp, c.input, opts.trivia as RunnableLike | undefined, opts.rootTrivia)
    const dt = digestRun(tbl as RunnableLike, c.input, opts.trivia as RunnableLike | undefined, opts.rootTrivia)
    const dr = digestRun(ref as RunnableLike, c.input, opts.trivia as RunnableLike | undefined, opts.rootTrivia)
    let ok = true
    if (dt !== di) { ok = false; report.mismatches.push({ case: c.name, path: 'table vs interpreted', a: dt, b: di }) }
    if (dc !== undefined && dt !== dc) { ok = false; report.mismatches.push({ case: c.name, path: 'table vs compiled', a: dt, b: dc }) }
    if (dt !== dr) { ok = false; report.mismatches.push({ case: c.name, path: 'assembled vs reference table', a: dt, b: dr }) }
    if (ok) report.matched++
  }
  return report
}
