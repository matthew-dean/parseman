/**
 * MEASURE BACKTRACKING — the check behind "Parséman never backtracks".
 *
 * `backtrackProbe(grammar, engine)` parses with an instrumented copy of the grammar
 * and reports, per parse, how often the position went backwards and how many bytes
 * were read again, plus the lookahead it did (`BacktrackCounts`,
 * `table/backtrack-probe.ts`). Each `measure` also runs the plain grammar and refuses
 * to report if the instrumented parse returned anything else.
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
import { tableRules } from '../table/assemble.ts'
import {
  BacktrackRecorder, hasLookaround, probeProgram, probeRules, type BacktrackCounts,
} from '../table/backtrack-probe.ts'
import { rebuildCombinator } from './rebuild.ts'

export type { BacktrackCounts } from '../table/backtrack-probe.ts'

export type BacktrackEngine = 'interpreter' | 'closure' | 'emitted'

export type BacktrackMeasurement = {
  readonly result: RunResult
  readonly counts: BacktrackCounts
}

export type BacktrackProbe = {
  /** The engine probed parses run on; `refusal` says why `emitted` fell back to closures. */
  readonly engine: { readonly ran: BacktrackEngine; readonly refusal?: string }
  /**
   * Parse `input` from rule `entry`, plainly and probed, and count the probed parse.
   * Throws if the two parses differ in outcome, value or where they stopped.
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
  return digestValue({ ok: r.ok, value: r.value, unconsumedFrom: r.unconsumedFrom })
}

/**
 * Probe a grammar on one engine.
 *
 * `grammar` is a rule map of combinators (a `rules()` or `compose()` result), or a
 * table program for the two table engines. A rule map runs on the table engines
 * through `compileRuleMap`, the same lowering a macro build ships.
 */
export function backtrackProbe(
  grammar: Readonly<Record<string, unknown>> | TableProgram | CompactProgram,
  engine: BacktrackEngine = 'closure',
): BacktrackProbe {
  const rec = new BacktrackRecorder()
  let plain: (entry: string) => Runnable
  let probed: (entry: string) => Runnable
  let ran: BacktrackProbe['engine']

  if (engine === 'interpreter') {
    if (isProgram(grammar)) throw new TypeError('backtrackProbe: the interpreter runs a rule map of combinators, not a table program')
    const rules = Object.fromEntries(ruleEntries(grammar))
    const built = new Map<string, Combinator<unknown>>()
    const instrument = instrumentFor(rec)
    plain = entry => ruleOf(rules, entry)
    probed = (entry) => {
      let hit = built.get(entry)
      if (hit === undefined) {
        hit = rebuildCombinator(ruleOf(rules, entry), new Map(), { thaw: true, after: instrument }).root
        built.set(entry, hit)
      }
      return hit
    }
    ran = { ran: 'interpreter' }
  }
  else {
    let prog: TableProgram
    if (isProgram(grammar)) prog = expandCompact(grammar)
    else {
      const refusals: string[] = []
      const compiled = compileRuleMapRunnable(ruleEntries(grammar), { refusals })
      if (compiled === null) throw new Error(`backtrackProbe: this grammar could not be encoded to a table: ${refusals.join('; ')}`)
      prog = compiled.prog
    }
    const base = tableRules({ ...prog, asm: [] })
    const { rules, engine: e } = probeRules(probeProgram(prog, rec), engine)
    plain = entry => ruleOf(base, entry)
    probed = entry => ruleOf(rules, entry)
    ran = e.refusal === undefined ? { ran: e.ran } : { ran: e.ran, refusal: e.refusal }
  }

  return {
    engine: ran,
    measure(entry, input, options = {}) {
      const expected = run(plain(entry), input, options)
      rec.begin(input)
      const result = run(probed(entry), input, options)
      const counts = rec.end()
      if (outcome(result) !== outcome(expected)) {
        throw new Error(`backtrackProbe: the probed ${ran.ran} parse of rule ${JSON.stringify(entry)} differs from the plain one; its counts would describe another parse`)
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

