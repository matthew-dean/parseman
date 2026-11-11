/**
 * The parse these benches measure: a compiled parser that records every trivia gap
 * in the document.
 *
 * From parseman 0.62.0 that is `run(compiled, input, { rootTrivia: { select: 'all' } })`.
 * Before it, the same log was a `_triviaLog` array on the context. A cross-version
 * A/B drives both releases from this checkout's bench code, so the call is chosen per
 * side, by whether that side's `compile()` result carries the entry `run()` unwraps.
 *
 * The two releases return different envelopes (`RunResult`, `ParseResult`), so a check
 * that two sides parsed alike compares `value`, the tree both build: see `parsedTree`.
 */
type CompiledLike = { parseWithContext: (input: string, ctx: never, pos?: number) => unknown }
type RunLike = (entry: never, input: string, options: { rootTrivia: { select: 'all' } }) => unknown

const COMPILED_ENTRY = Symbol.for('parseman.compiledEntry')
const ALL = { rootTrivia: { select: 'all' } } as const

export function allTriviaParse(run: RunLike, compiled: CompiledLike, input: string): () => unknown {
  if (COMPILED_ENTRY in compiled) return () => run(compiled as never, input, ALL)
  return () => compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] } as never, 0)
}

/** The tree a parse built, which both envelopes carry as `value`. */
export function parsedTree(result: unknown): unknown {
  return (result as { value?: unknown }).value
}
