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
   * The grammar's trivia rule. A root rule consumes trivia BETWEEN terms but not
   * after the last one, so trailing whitespace/comments would otherwise look like
   * unparsed input. Given the trivia rule, `run` skips that tail before computing
   * `unconsumedFrom` — so only real leftover is reported. Also encodes dialect
   * differences for free: pass the CSS trivia and a trailing `//` counts as
   * leftover; pass the Less trivia (which treats `//` as a line comment) and it
   * doesn't. An UNTERMINATED comment (which the trivia rule won't match) surfaces
   * at its start. Omit to require the parse to reach the exact end itself.
   */
  trivia?: Runnable
  /**
   * Restrict PER-NODE CST trivia capture (the `triviaLog` a node's builder sees)
   * to these trivia kinds — a bitmask over the grammar's `triviaKindLabels`
   * indices (build it with `triviaKindMask(labels, ['comment', …])`). Unlisted
   * kinds (e.g. whitespace) are skipped over but not recorded per node, so a host
   * that only reads comments doesn't pay to log every whitespace run. The global
   * `triviaLog` returned by `run()` is unaffected. Omit to capture every kind.
   */
  triviaCaptureMask?: number
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
  /**
   * Flat trivia log for building a trivia map. Entry width depends on whether the
   * grammar uses labeled trivia: 2 numbers per entry (`start, end`) for plain
   * trivia, 3 numbers per entry (`start, end, kindIndex`) for labeled trivia
   * (grammars with `label()` arms in their trivia choice). Use `buildTriviaIndex`
   * / `triviaEntries` to consume it format-agnostically rather than iterating raw.
   */
  triviaLog: number[]
  /** Offset where unparsed input begins — the first non-trivia character the parse
   * left unconsumed (trailing trivia skipped when `trivia` is given), or null if
   * the whole input was consumed. This is how you detect "the grammar stopped short,
   * there's junk here". Only meaningful on success — a failed parse reports its own
   * `span`/`expected`. */
  unconsumedFrom: number | null
}

const invoke = (r: Runnable, input: string, pos: number, ctx: ParseContext): ParseResult<unknown> =>
  typeof r === 'function' ? r(input, pos, ctx) : r.parse(input, pos, ctx)

export function run(entry: Runnable, input: string, options: RunOptions = {}): RunResult {
  if (typeof entry !== 'function' && typeof (entry as Combinator<unknown> | undefined)?.parse !== 'function') {
    throw new TypeError(
      `run(): start production is ${entry === null ? 'null' : typeof entry}, not a rule — the requested grammar rule does not exist (check the rule name).`,
    )
  }
  const triviaLog: number[] = []
  const errors: ParseError[] = []
  // Grammar-level ambient trivia declared via rules(factory, { trivia }): install
  // it as ctx.trivia so it's ambient for the whole parse (the interpreter path;
  // a compiled entry has it baked in and carries no _meta). parser/noTrivia still
  // override locally.
  const grammarTrivia = typeof entry !== 'function' ? entry._meta.grammarTrivia : undefined
  const ctx: ParseContext = {
    trackLines: false,
    _triviaLog: triviaLog,
    _errors: errors,
    build: options.build,
    state: options.state,
    ...(grammarTrivia !== undefined
      ? { trivia: grammarTrivia, ...(grammarTrivia._meta.triviaKindLabels ? { triviaKindLabels: grammarTrivia._meta.triviaKindLabels } : {}) }
      : {}),
    ...(options.triviaCaptureMask !== undefined ? { _triviaCaptureMask: options.triviaCaptureMask } : {}),
  }
  const r = invoke(entry, input, 0, ctx)

  let unconsumedFrom: number | null = null
  if (r.ok) {
    let pos = r.span?.end ?? 0
    if (options.trivia && pos < input.length) {
      // Throwaway ctx: trailing trivia must NOT pollute the parse's trivia log.
      const t = invoke(options.trivia, input, pos, { trackLines: false })
      if (t.ok && t.span.end > pos) pos = t.span.end
    }
    unconsumedFrom = pos < input.length ? pos : null
  }

  return {
    ok: r.ok,
    value: r.ok ? (r as { value: unknown }).value : undefined,
    span: r.span ?? { start: 0, end: 0 },
    expected: r.ok ? [] : ((r as { expected?: string[] }).expected ?? []),
    errors,
    triviaLog,
    unconsumedFrom,
  }
}
