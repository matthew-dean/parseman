/**
 * MEASURE BACKTRACKING among the terminals a parse matched.
 *
 * `backtrackProbe(grammar, engine)` parses with an instrumented copy of the grammar
 * and reports, per parse, how often a matched terminal started behind the one before
 * it and how many bytes matched twice, plus the lookahead it did (`BacktrackCounts`,
 * `table/backtrack-probe.ts`). Each `measure` also runs the plain grammar, returns
 * that result, and refuses to report if the instrumented parse returned anything else.
 *
 * Counts of zero do not show a parse wasted nothing. Failed reads, trivia re-scans,
 * the choice predecide pretest and table `token()` bodies go uncounted; the list and
 * an example are in `table/backtrack-probe.ts`.
 *
 * Three engines, one rule. `closure` and `emitted` run a rewritten copy of the
 * table (`probeProgram`); `interpreter` runs a rebuilt copy of the combinator graph
 * whose terminals report to the same recorder. Nothing here is reachable from a
 * parse that did not ask for it, which is why it costs an ordinary parse nothing.
 */
import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { run, type RunOptions, type RunResult } from '../functional/run.ts'
import { digestValue } from '../oracle/digest.ts'
import { compileRuleMapRunnable } from '../table/compile-rule-map.ts'
import { expandCompact, type CompactProgram, type TableProgram } from '../table/program.ts'
import { AssemblyCache, tableRules } from '../table/assemble.ts'
import {
  BacktrackRecorder, hasLookaround, probeCfg, probeProgram, type BacktrackCounts,
} from '../table/backtrack-probe.ts'
import { rebuildCombinator } from './rebuild.ts'

export type { BacktrackCounts } from '../table/backtrack-probe.ts'

export type BacktrackEngine = 'interpreter' | 'closure'

export type BacktrackMeasurement = {
  readonly result: RunResult
  readonly counts: BacktrackCounts
}

export type BacktrackProbe = {
  /** The engine probed parses run on. */
  readonly engine: { readonly ran: BacktrackEngine | 'emitted' }
  /**
   * Parse `input` from rule `entry`, plainly and probed, count the probed parse and
   * return the plain parse's result. Throws if the two parses differ in outcome, value
   * or where they stopped.
   *
   * Both parses get the same `options.state`, the plain one first. A grammar that
   * writes state (a `gate()` that mutates it, say) sees the first parse's writes in the
   * second, so the measure either throws or counts a different parse, possibly with
   * fewer rewinds. Measure such a grammar only if resetting its state makes no difference.
   */
  measure(entry: string, input: string, options?: RunOptions): BacktrackMeasurement
}

type Runnable = Parameters<typeof run>[0]

function isCombinator(x: unknown): x is Combinator<unknown> {
  return typeof x === 'object' && x !== null && '_def' in x
    && typeof (x as { parse?: unknown }).parse === 'function'
}

function isProgram(x: object): x is TableProgram | CompactProgram {
  return Array.isArray((x as { code?: unknown }).code) || Array.isArray((x as { c?: unknown }).c)
}

/** The rules a `compile()` of this map would encode: combinators, minus undefined refs. */
function ruleEntries(grammar: Record<string, unknown>): Array<[string, Combinator<unknown>]> {
  const out: Array<[string, Combinator<unknown>]> = []
  for (const [name, value] of Object.entries(grammar)) {
    if (!isCombinator(value)) continue
    if (value._def.tag === 'lazy') {
      try { value._def.thunk() } catch { continue }
    }
    out.push([name, value])
  }
  return out
}

function outcome(r: RunResult): string {
  return digestValue({ ok: r.ok, value: r.value, span: r.span, unconsumedFrom: r.unconsumedFrom })
}

type Grammar = Readonly<Record<string, unknown>> | TableProgram | CompactProgram

function tableOf(grammar: Grammar): TableProgram {
  if (isProgram(grammar)) return expandCompact(grammar)
  const refusals: string[] = []
  const compiled = compileRuleMapRunnable(ruleEntries(grammar), { refusals })
  if (compiled === null) throw new Error(`backtrackProbe: this grammar could not be encoded to a table: ${refusals.join('; ')}`)
  return compiled.prog
}

/**
 * Probe a grammar on one engine.
 *
 * `grammar` is a rule map of combinators (a `rules()` or `compose()` result), or a
 * table program for the closure engine. A rule map runs on the table through
 * `compileRuleMapRunnable`, the lowering `compile()` uses.
 *
 * The emitted engine is not offered here: it needs code built from source, which
 * at runtime only `compile()` may do (`docs/design/runtime-and-size-contract.md`,
 * rule 1). Tests and benches reach it through `backtrackProbeAssembled` with a
 * build-time module (`bench/emitted-assembly.ts`). It counts what the closure
 * engine counts, because both run the same rewritten program.
 */
export function backtrackProbe(grammar: Grammar, engine: BacktrackEngine = 'closure'): BacktrackProbe {
  const rec = new BacktrackRecorder()
  if (engine === 'interpreter') {
    if (isProgram(grammar)) throw new TypeError('backtrackProbe: the interpreter runs a rule map of combinators, not a table program')
    const rules = Object.fromEntries(ruleEntries(grammar))
    const built = new Map<string, Combinator<unknown>>()
    const instrument = instrumentFor(rec)
    return probe(rec, 'interpreter', entry => ruleOf(rules, entry), (entry) => {
      let hit = built.get(entry)
      if (hit === undefined) {
        hit = rebuildCombinator(ruleOf(rules, entry), new Map(), { thaw: true, after: instrument }).root
        built.set(entry, hit)
      }
      return hit
    })
  }
  if (engine !== 'closure') throw new TypeError(`backtrackProbe: no engine ${JSON.stringify(engine)}; it runs 'closure' or 'interpreter'`)
  const prog = tableOf(grammar)
  const base = tableRules({ ...prog, asm: [] })
  const rules = tableRules(probeProgram(prog, rec))
  return probe(rec, 'closure', entry => ruleOf(base, entry), entry => ruleOf(rules, entry))
}

/**
 * For tests and benches, not `parseman/diagnostics`: the probe on the emitted
 * engine. `assemble` hands the rewritten program back with a pre-compiled
 * assembly for `probeCfg(program)`, built as a module the way a macro build ships
 * one. Nothing here turns a string into code, and a program with no assembly is
 * refused, because the assembler would.
 */
export async function backtrackProbeAssembled(
  grammar: Grammar,
  assemble: (probed: TableProgram) => Promise<TableProgram>,
): Promise<BacktrackProbe> {
  const rec = new BacktrackRecorder()
  const prog = tableOf(grammar)
  const base = tableRules({ ...prog, asm: [] })
  const assembled = await assemble(probeProgram(prog, rec))
  // A program with no inventory would make the assembler build the engine from source.
  if (assembled.asm === undefined) throw new TypeError('backtrackProbeAssembled: `assemble` returned a program with no pre-compiled assembly')
  // Ask the assembler which engine it built, rather than assume the factory was taken.
  const refusal = new AssemblyCache(assembled).for(probeCfg(assembled)).emitRefusal
  if (refusal !== undefined) throw new Error(`backtrackProbeAssembled: the assembly was not used: ${refusal}`)
  const rules = tableRules(assembled)
  const emitted = probe(rec, 'emitted', entry => ruleOf(base, entry), entry => ruleOf(rules, entry))
  return {
    engine: emitted.engine,
    measure(entry, input, options = {}) {
      // The assembly serves `probeCfg`'s option set alone. An option that selects
      // another one (tolerant, completions, a build host…) would run closures under
      // an `emitted` label, so only the parse state may be passed.
      const other = Object.keys(options).filter(k => k !== 'state')
      if (other.length > 0) throw new TypeError(`backtrackProbeAssembled: the emitted probe runs a plain parse; it takes no ${other.join(', ')}`)
      return emitted.measure(entry, input, options)
    },
  }
}

function probe(
  rec: BacktrackRecorder,
  ran: BacktrackProbe['engine']['ran'],
  plain: (entry: string) => Runnable,
  probed: (entry: string) => Runnable,
): BacktrackProbe {
  return {
    engine: { ran },
    measure(entry, input, options = {}) {
      const result = run(plain(entry), input, options)
      rec.begin(input)
      const probedResult = run(probed(entry), input, options)
      const counts = rec.end()
      if (outcome(probedResult) !== outcome(result)) {
        throw new Error(`backtrackProbe: the probed ${ran} parse of rule ${JSON.stringify(entry)} differs from the plain one; its counts would describe another parse`)
      }
      return { result, counts }
    },
  }
}

function ruleOf<T>(rules: Readonly<Record<string, T>>, entry: string): T {
  if (!Object.hasOwn(rules, entry)) throw new Error(`backtrackProbe: the grammar has no rule ${JSON.stringify(entry)}`)
  return rules[entry]!
}

type Parse = (input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>

function wrapped(out: Combinator<unknown>, parse: Parse): Combinator<unknown> {
  const w: Combinator<unknown> = { _tag: out._tag, _meta: out._meta, _def: out._def, parse }
  const name = (out as { _ruleName?: string })._ruleName
  if (name !== undefined) (w as { _ruleName?: string })._ruleName = name
  return w
}

/**
 * The interpreter's half of the rewrite `probeProgram` makes to a table: terminals
 * report their span, a lookahead marks its extent, and a scan's own reads stay
 * inside it. The rebuilt node is wrapped, never patched, so the grammar the caller
 * holds is untouched.
 */
function instrumentFor(rec: BacktrackRecorder): (original: Combinator<unknown>, rebuilt: Combinator<unknown>) => Combinator<unknown> {
  return (_original, out) => {
    const d = out._def
    switch (d.tag) {
      case 'literal': case 'keywords':
        return wrapped(out, (input, pos, ctx) => {
          const r = out.parse(input, pos, ctx)
          if (r.ok) rec.consume(r.span.start, r.span.end)
          return r
        })
      case 'regex': {
        const re = new RegExp(d.source, d.flags)
        if (!hasLookaround(re)) {
          return wrapped(out, (input, pos, ctx) => {
            const r = out.parse(input, pos, ctx)
            if (r.ok) rec.consume(r.span.start, r.span.end)
            return r
          })
        }
        return wrapped(out, (input, pos, ctx) => {
          rec.regexAttempt()
          const r = out.parse(input, pos, ctx)
          if (r.ok) rec.regexMatch(re, r.span.start, r.span.end)
          return r
        })
      }
      case 'scanTo': case 'lines': case 'columns': case 'recover': case 'unknown':
        return wrapped(out, (input, pos, ctx) => {
          rec.enterOpaque()
          let r: ParseResult<unknown>
          try { r = out.parse(input, pos, ctx) } finally { rec.exitOpaque() }
          if (r.ok) rec.consume(r.span.start, r.span.end)
          return r
        })
      case 'not': case 'peek':
        return wrapped(out, (input, pos, ctx) => {
          rec.enterLookahead()
          try { return out.parse(input, pos, ctx) } finally { rec.exitLookahead() }
        })
      default:
        return out
    }
  }
}

