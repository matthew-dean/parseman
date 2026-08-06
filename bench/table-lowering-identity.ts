/**
 * Correctness gate: the table lowering must produce the SAME tree as the
 * shipped lowerings for a grammar's whole corpus.
 *
 * Oracle is `parseman/oracle`'s `digestValue` — the repo's byte-identity
 * primitive — applied to the `run()` result of three paths over one input:
 *
 *   interpreted   the combinator graph            (semantic reference)
 *   compiled      compileRuleMap()                (what ships today)
 *   table         encodeTable() + tableRules()    (what this lane builds)
 *
 * `interpreted ≡ compiled` is already gated by `test/parity/*`, so
 * `table ≡ interpreted` and `table ≡ compiled` together pin the new path.
 */
import { digestValue } from '../src/oracle/index.ts'
import { run } from '../src/functional/run.ts'
import { compose } from '../src/compiler/linker.ts'
import { encodeTable, type TableSettings } from '../src/table/encode.ts'
/**
 * `assembledRules` IS THE SHIPPED TABLE ENGINE — `src/table/index.ts` re-exports
 * it under the name `tableRules`, and `compileTable`/`compileRuleMapTable` build
 * through it. This sweep imported the name `tableRules` from `src/table/exec.ts`
 * instead, which is the REFERENCE driver: every case here, and every case in the
 * CI subset (`test/unit/table-identity.test.ts`), gated a driver nothing ships
 * while the assembler went unexecuted.
 *
 * Both legs run now. `assembled` is the one under gate; `reference` stays because
 * `exec.ts` is what an assembler divergence gets bisected against, and losing it
 * would trade one blind spot for another.
 */
import { assembledRules } from '../src/table/assemble.ts'
import { tableRules as referenceRules } from '../src/table/exec.ts'
import type { Combinator } from '../src/types.ts'

export type Paths = {
  interpreted: Record<string, Combinator<unknown>>
  compiled: Record<string, (input: string, pos: number, ctx: never) => unknown>
  table: ReturnType<typeof assembledRules>
}

/** Build the shipped table path for one rule map + settings pair. */
export function buildPaths(
  ruleMap: Record<string, Combinator<unknown>>,
  settings: TableSettings = {},
): { table: ReturnType<typeof assembledRules>; compiledSource: string } {
  const prog = encodeTable(ruleMap, settings)
  return { table: assembledRules(prog), compiledSource: '' }
}

export type IdentityCase = { name: string; input: string }

export type IdentityReport = {
  total: number
  matched: number
  mismatches: Array<{ case: string; path: string; a: string; b: string }>
}

type RunnableLike = Parameters<typeof run>[0]

function digestRun(entry: RunnableLike, input: string, trivia?: RunnableLike): string {
  const r = run(entry, input, trivia === undefined ? {} : { trivia })
  // Digest the OUTCOME, not just the value: ok, value, and where the parse
  // stopped. A path that silently consumed less would otherwise pass.
  // FAILURE IS PART OF THE OUTPUT. Digesting only { ok, value, unconsumedFrom }
  // made every divergence in HOW a parse fails invisible to every sweep — a
  // table could report the wrong expected set, or none at all, and agree.
  // `expected` is sorted because neither engine promises an order and an
  // ordering difference is not a semantic one.
  return digestValue({
    ok: r.ok,
    value: r.value,
    unconsumedFrom: r.unconsumedFrom,
    expected: r.ok ? undefined : [...(r.expected ?? [])].sort(),
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
     * Gate against the INTERPRETER only. For a grammar that exposes an entry
     * combinator but not its rule map, `compose()` cannot fuse it — the compiled
     * leg is unavailable, not passing. Callers must say which they got.
     */
    interpreterOnly?: boolean
  } = {},
): IdentityReport {
  const settings = opts.settings ?? {}
  const interp = ruleMap[entryRule]
  if (interp === undefined) throw new Error(`no rule '${entryRule}'`)

  const prog = encodeTable(ruleMap, settings)
  const tbl = assembledRules(prog)[entryRule]
  if (tbl === undefined) throw new Error(`table has no rule '${entryRule}'`)
  const ref = referenceRules(prog)[entryRule]
  if (ref === undefined) throw new Error(`reference table has no rule '${entryRule}'`)

  // The shipped compiled path, fused at runtime (same codegen, `new Function`
  // instead of a build-time splice).
  const compiledMap = opts.interpreterOnly
    ? undefined
    : compose([ruleMap as never]) as unknown as Record<string, RunnableLike>
  const comp = compiledMap?.[entryRule]
  if (comp === undefined && !opts.interpreterOnly) throw new Error(`compiled map has no rule '${entryRule}'`)

  const report: IdentityReport = { total: 0, matched: 0, mismatches: [] }
  for (const c of cases) {
    report.total++
    const di = digestRun(interp as RunnableLike, c.input, opts.trivia as RunnableLike | undefined)
    const dc = comp === undefined ? undefined : digestRun(comp, c.input, opts.trivia as RunnableLike | undefined)
    const dt = digestRun(tbl as RunnableLike, c.input, opts.trivia as RunnableLike | undefined)
    const dr = digestRun(ref as RunnableLike, c.input, opts.trivia as RunnableLike | undefined)
    let ok = true
    if (dt !== di) { ok = false; report.mismatches.push({ case: c.name, path: 'table vs interpreted', a: dt, b: di }) }
    if (dc !== undefined && dt !== dc) { ok = false; report.mismatches.push({ case: c.name, path: 'table vs compiled', a: dt, b: dc }) }
    if (dt !== dr) { ok = false; report.mismatches.push({ case: c.name, path: 'assembled vs reference table', a: dt, b: dr }) }
    if (ok) report.matched++
  }
  return report
}
