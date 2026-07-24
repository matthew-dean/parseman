import type { Combinator, ParseContext, ParseError, ParseResult } from '../types.ts'
import { REC } from '../recovery/scan.ts'

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
  /** Optional hooks for a coverage-enabled compiled or macro parser. Ordinary
   * parses omit this completely, so instrumentation has no normal-path cost. */
  instrumentation?: {
    _grammarCoverage?: (id: string) => void
    _grammarTrace?: { write(event: { id: string; phase: 'enter' | 'attempt' | 'selected' | 'success' | 'failure' | 'backtrack' | 'rollback'; offset: number; end?: number }): void }
  }
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
  /**
   * Activate automatic list recovery. When true, `many`/`sepBy`/`oneOrMore` recover
   * from a failed element — skip to a sync point (a resume token inferred from the
   * grammar's structure; the grammar carries no recovery config), emit a
   * `ParseError` over the skipped span (collected in `errors`), and keep parsing the
   * rest of the list — instead of stopping at the first bad element. Omit (the
   * default) for the strict "one clean error and stop" behavior, byte-identical to a
   * run with no recovery. Recovery is a cold path: on well-formed input nothing
   * fails, so none of the machinery runs.
   */
  tolerant?: boolean
  /**
   * Run three compiled-parser-only profiling passes: recognizer (no global
   * sinks), structural capture without the host, then the normal host path. This
   * is a measurement boundary, not a parser mode; ordinary `run()` output is
   * unchanged when omitted. The input is parsed THREE times — each pass gets its
   * own shallow copy of `options.state`, so keep per-parse state shallow (only
   * the top level is isolated between passes).
   */
  profile?: boolean
}

export type RunProfilePass = {
  ms: number
  nodes: number
  childSlots: number
  rawSlots: number
  triviaSlots: number
  fieldSlots: number
  hostCalls: number
}

export type RunProfile = {
  /** Existing `voidOf(transform(..., () => undefined))` semantics, generalized
   * to compiled structural nodes: no `ch`/`raw`/`tl` capture or raw entries. */
  recognizer: RunProfilePass
  /** Captures children/raw/trivia/fields but suppresses node construction. */
  structuralCapture: RunProfilePass
  /** The ordinary parser path, including its injected build host. */
  hostConstruction: RunProfilePass
}

export type RunResult = {
  ok: boolean
  /** The entry's value on success; undefined on failure. */
  value: unknown
  span: { start: number; end: number }
  /** Expected-token set when the TOP-LEVEL parse failed (empty on success). */
  expected: string[]
  /** Recovery diagnostics (tolerant lists / `expect()`) collected during the parse (in order). */
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
  /** Present only when `RunOptions.profile` is true. */
  profile?: RunProfile
}

const invoke = (r: Runnable, input: string, pos: number, ctx: ParseContext): ParseResult<unknown> =>
  typeof r === 'function' ? r(input, pos, ctx) : r.parse(input, pos, ctx)

type ProfilePhase = NonNullable<ParseContext['_pmProfile']>['phase']
type ProfileState = NonNullable<ParseContext['_pmProfile']>

function runOnce(entry: Runnable, input: string, options: RunOptions, phase?: ProfilePhase, profileState?: ProfileState): RunResult {
  if (typeof entry !== 'function' && typeof (entry as Combinator<unknown> | undefined)?.parse !== 'function') {
    throw new TypeError(
      `run(): start production is ${entry === null ? 'null' : typeof entry}, not a rule — the requested grammar rule does not exist (check the rule name).`,
    )
  }
  const triviaLog: number[] = []
  const errors: ParseError[] = []
  const profile = profileState ?? (phase === undefined
    ? undefined
    : { phase, nodes: 0, childSlots: 0, rawSlots: 0, triviaSlots: 0, fieldSlots: 0, hostCalls: 0 })
  // NOT "no output" — the `capture` phase still allocates per-node children/raw/
  // trivia buffers and records slot counts. This flag only omits the two GLOBAL
  // sinks (`_triviaLog`, `_errors`) from the context; hence `skipGlobalSinks`.
  const skipGlobalSinks = phase === 'recognizer' || phase === 'capture'
  // Grammar-level ambient trivia declared via rules({ trivia }, factory): install
  // it as ctx.trivia so it's ambient for the whole parse (the interpreter path;
  // a compiled entry has it baked in and carries no _meta). parser/noTrivia still
  // override locally.
  const grammarTrivia = typeof entry !== 'function' ? entry._meta.grammarTrivia : undefined
  const grammarScanSkip = typeof entry !== 'function' ? entry._meta.grammarScanSkip : undefined
  const ctx: ParseContext = {
    trackLines: false,
    ...(skipGlobalSinks
      ? { _pmProfile: profile! }
      : { _triviaLog: triviaLog, _errors: errors, ...(profile === undefined ? {} : { _pmProfile: profile }) }),
    build: options.build,
    state: options.state,
    ...(grammarTrivia !== undefined
      ? { trivia: grammarTrivia, ...(grammarTrivia._meta.triviaKindLabels ? { triviaKindLabels: grammarTrivia._meta.triviaKindLabels } : {}) }
      : {}),
    ...(grammarScanSkip !== undefined ? { scanSkip: grammarScanSkip } : {}),
    ...(options.triviaCaptureMask !== undefined ? { _triviaCaptureMask: options.triviaCaptureMask } : {}),
    ...(options.tolerant ? { _tolerant: true, _rec: REC } : {}),
    ...(options.instrumentation === undefined ? {} : options.instrumentation),
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

/** Shallow copy of `options.state` per pass so an in-place mutation by one
 * profiling pass doesn't leak into the next (the parity check only compares
 * `ok`/`unconsumedFrom`, so a diverged structural output would go unnoticed).
 * Only the top level is isolated — deeply-nested mutable state is shared; a
 * profiled grammar should keep per-parse state shallow (see the `profile` docs). */
function clonePassState(state: unknown): unknown {
  if (state === null || typeof state !== 'object') return state
  return Array.isArray(state) ? [...state] : { ...(state as Record<string, unknown>) }
}

function profilePass(entry: Runnable, input: string, options: RunOptions, phase: ProfilePhase): { result: RunResult; profile: RunProfilePass } {
  const state: ProfileState = { phase, nodes: 0, childSlots: 0, rawSlots: 0, triviaSlots: 0, fieldSlots: 0, hostCalls: 0 }
  const passOptions: RunOptions = options.state === undefined ? options : { ...options, state: clonePassState(options.state) }
  const start = performance.now()
  const result = runOnce(entry, input, passOptions, phase, state)
  const { phase: _phase, ...counts } = state
  return { result, profile: { ms: performance.now() - start, ...counts } }
}

export function run(entry: Runnable, input: string, options: RunOptions = {}): RunResult {
  if (!options.profile) return runOnce(entry, input, options)
  if (typeof entry !== 'function') {
    throw new TypeError('run({ profile: true }) requires a compiled parser entry')
  }

  const recognizer = profilePass(entry, input, options, 'recognizer')
  const capture = profilePass(entry, input, options, 'capture')
  const host = profilePass(entry, input, options, 'host')
  if (recognizer.result.ok !== host.result.ok || capture.result.ok !== host.result.ok
    || recognizer.result.unconsumedFrom !== host.result.unconsumedFrom
    || capture.result.unconsumedFrom !== host.result.unconsumedFrom) {
    throw new Error('run({ profile: true }) changed recognition; the grammar is not profile-safe')
  }
  return {
    ...host.result,
    profile: {
      recognizer: recognizer.profile,
      structuralCapture: capture.profile,
      hostConstruction: host.profile,
    },
  }
}
