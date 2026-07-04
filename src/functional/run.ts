import type { Combinator, ParseContext, ParseError, ParseResult } from '../types.ts'

/**
 * Run a compiled/interpreted grammar entry against an input and collect the raw
 * outcome a tool needs to shape a parse result — WITHOUT the consumer having to
 * hand-build a `ctx`, branch on function-vs-combinator, or scan for leftover
 * input itself.
 *
 * A `compile()`/macro grammar hands you a map of bare parse FUNCTIONS; the
 * interpreter hands you COMBINATORS. `run()` invokes either, threads the standard
 * framework ctx (trivia log, recover/expect error sink, the `ctx.build` host,
 * grammar state), and — given the grammar's trivia parser — reports where
 * non-trivia input was left unconsumed. The consumer keeps only its own policy:
 * how to shape the tree and how to turn diagnostics into its error type.
 */

/** A compiled rule (macro/`compile()` output) OR an interpreter combinator. */
export type Runnable =
  | ((input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>)
  | Combinator<unknown>

export type RunOptions = {
  /** `ctx.build` host — makes structural `node()` rules build a CST / AST via the
   * host instead of their own eval builders. Omit for a grammar's own builders. */
  build?: ParseContext['build']
  /** Initial grammar state threaded into `ctx.state`. */
  state?: unknown
  /**
   * The grammar's trivia parser. When given, trailing trivia after the parse is
   * skipped before computing `leftoverAt`, so trailing whitespace/comments aren't
   * mistaken for leftover — and an UNTERMINATED comment (which the trivia parser
   * won't match) surfaces at its start. Encodes dialect differences for free:
   * pass the CSS trivia and `//` is leftover; pass the Less trivia and it isn't.
   */
  trailingTrivia?: Runnable
}

export type RunResult = {
  ok: boolean
  /** The entry's value on success; undefined on failure. */
  value: unknown
  span: { start: number; end: number }
  /** Expected-token set when the TOP-LEVEL parse failed (empty on success). */
  expected: string[]
  /** `recover()` / `expect()` diagnostics collected during the parse (in order). */
  errors: ParseError[]
  /** Flat trivia log — `[start, end]` pairs — for building a trivia map. */
  triviaLog: number[]
  /** First offset of non-trivia input left unconsumed after the parse (trailing
   * trivia skipped when `trailingTrivia` is given), or null if fully consumed.
   * Only meaningful on success — a failed parse reports its own `span`/`expected`. */
  leftoverAt: number | null
}

const invoke = (r: Runnable, input: string, pos: number, ctx: ParseContext): ParseResult<unknown> =>
  typeof r === 'function' ? r(input, pos, ctx) : r.parse(input, pos, ctx)

export function run(entry: Runnable, input: string, options: RunOptions = {}): RunResult {
  const triviaLog: number[] = []
  const errors: ParseError[] = []
  const ctx: ParseContext = {
    trackLines: false,
    _triviaLog: triviaLog,
    _errors: errors,
    build: options.build,
    state: options.state,
  }
  const r = invoke(entry, input, 0, ctx)

  let leftoverAt: number | null = null
  if (r.ok) {
    let pos = r.span?.end ?? 0
    if (options.trailingTrivia && pos < input.length) {
      // Throwaway ctx: trailing trivia must NOT pollute the parse's trivia log.
      const t = invoke(options.trailingTrivia, input, pos, { trackLines: false })
      if (t.ok && t.span.end > pos) pos = t.span.end
    }
    leftoverAt = pos < input.length ? pos : null
  }

  return {
    ok: r.ok,
    value: r.ok ? (r as { value: unknown }).value : undefined,
    span: r.span ?? { start: 0, end: 0 },
    expected: r.ok ? [] : ((r as { expected?: string[] }).expected ?? []),
    errors,
    triviaLog,
    leftoverAt,
  }
}
