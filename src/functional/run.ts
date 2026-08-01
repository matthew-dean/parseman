import type { Combinator, ParseContext, ParseError, ParseResult } from '../types.ts'
import { REC } from '../recovery/scan.ts'
import { buildRootTriviaIndex, type RootTriviaIndex } from '../cst/trivia-entries.ts'
/* `cst/host-mode.ts` and `cst/trivia-entries.ts` are import-free by design, so
 * this keeps the `parseman/run` closure minimal — see
 * test/unit/run-entry-closure.test.ts. */
import { assertHostModeCompatible, FUSED_HOST_MODE, FUSED_HOST_ELIDED, type HostMode } from '../cst/host-mode.ts'

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
   * that only reads comments doesn't pay to log every whitespace run. Omit to
   * capture every kind.
   */
  triviaCaptureMask?: number
  /**
   * Opt into sparse root trivia capture. `run()` retains no root trivia unless
   * this is supplied. Capture records only the named labels, each with the one
   * complete authored gap that owns it; ordinary whitespace has no root entry.
   */
  rootTrivia?: {
    readonly select: readonly string[]
  }
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
}

export type RootTriviaCapture = {
  /** Packed `[gapStart, gapEnd, markerStart, markerEnd, selectedKindIndex]` rows. */
  readonly rows: readonly number[]
  /** Labels requested by this caller; row kind indices refer to this array. */
  readonly select: readonly string[]
  /** Lazy lookup over `rows`; no tokens or strings are materialized. */
  readonly index: RootTriviaIndex
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
   * Sparse selected root trivia. This is present only when at least one requested
   * category was actually retained; omitted means the parse retained no root
   * trivia at all.
   */
  rootTrivia?: RootTriviaCapture
  /** Offset where unparsed input begins — the first non-trivia character the parse
   * left unconsumed (trailing trivia skipped when `trivia` is given), or null if
   * the whole input was consumed. This is how you detect "the grammar stopped short,
   * there's junk here". Only meaningful on success — a failed parse reports its own
   * `span`/`expected`. */
  unconsumedFrom: number | null
}

/**
 * 0.44 dropped three `RunResult` fields — `triviaMap` and `triviaLog`, both
 * MANDATORY in 0.43, and the optional `triviaKindLabels`. Removing them without
 * a signal makes each read `undefined`, and `undefined` travels: it surfaces as
 * a property access on nothing somewhere inside the CONSUMER's code, in a
 * message naming neither parseman, the field, nor the replacement. That is the
 * same defect as a diagnostic that reports a number when it means "I could not
 * run" — the tool's inability wearing the costume of a result.
 *
 * `triviaKindLabels` is the worst of the three despite being optional: it fed
 * `triviaKindMask`, which treats `undefined` as "capture everything", so its
 * removal silently changes behaviour rather than producing so much as a crash.
 *
 * So the names are kept as accessors that throw the migration. They are
 * NON-ENUMERABLE deliberately: absent from `Object.keys`, spreads,
 * `JSON.stringify` and identity digests, so restoring them moves no output and
 * costs nothing on the parse path — they exist only to answer a read.
 */
const SELECT_EXAMPLE = "run(entry, input, { rootTrivia: { select: ['blockComment', 'lineComment'] } })"

const REMOVED_RUN_RESULT_FIELDS: ReadonlyArray<readonly [string, string]> = [
  [
    'triviaMap',
    'It was a dense root-trivia index built on every parse; root trivia is now an OPT-IN sparse '
    + 'capture, because most grammars paid for an index they never read. Migration: name the trivia '
    + `labels your grammar defines — ${SELECT_EXAMPLE} — and read \`RunResult.rootTrivia\`, whose `
    + '`.index` carries the labels and gap lookups `triviaMap` exposed.',
  ],
  [
    'triviaLog',
    'It was the flat `start, end[, kindIndex]` log every other trivia view was derived from, and it '
    + 'is no longer allocated at all — not empty, absent. Migration: request the labels you need '
    + `— ${SELECT_EXAMPLE} — and read \`RunResult.rootTrivia.rows\`. Do NOT reuse a stride-2/3 reader: `
    + 'rows are a different width and a different unit (one row per SELECTED marker, not one per '
    + 'trivia chunk), so an old loop reads confidently wrong offsets rather than failing.',
  ],
  [
    'triviaKindLabels',
    'It was already optional, so nothing ever flagged its disappearance — and `triviaKindMask(undefined, '
    + '…)` means "capture everything", so reading it now silently WIDENS capture instead of erroring. '
    + `Migration: request labels — ${SELECT_EXAMPLE} — then the set you asked for is `
    + '`RunResult.rootTrivia.select` and the resolved table is `RunResult.rootTrivia.index.labels`.',
  ],
]

/**
 * `rootTrivia` is ABSENT rather than empty when no requested category was
 * retained, so branch on it — do not index into it.
 */
function guardRemovedFields(result: RunResult): RunResult {
  for (const [name, detail] of REMOVED_RUN_RESULT_FIELDS) {
    Object.defineProperty(result, name, {
      configurable: true,
      enumerable: false,
      get(): never {
        throw new TypeError(
          `RunResult.${name} was REMOVED in parseman 0.44.0 and has no default replacement. ${detail}`,
        )
      },
    })
  }
  return result
}

const invoke = (r: Runnable, input: string, pos: number, ctx: ParseContext): ParseResult<unknown> =>
  typeof r === 'function' ? r(input, pos, ctx) : r.parse(input, pos, ctx)

type RunnableMeta = {
  readonly _meta?: {
    readonly triviaKindLabels?: readonly string[]
    readonly rootTriviaClassified?: true
  }
}

function triviaKindLabelsFromRunnable(r: Runnable | undefined): readonly string[] | undefined {
  if (!r) return undefined
  if (typeof r === 'function') return (r as RunnableMeta)._meta?.triviaKindLabels
  const grammarTrivia = (r._meta as { grammarTrivia?: Combinator<unknown> }).grammarTrivia
  return grammarTrivia?._meta.triviaKindLabels
    ?? r._meta.triviaKindLabels
    ?? (r._def.tag === 'grammar' ? r._def.triviaParser?._meta.triviaKindLabels : undefined)
}

function rootTriviaClassifiedFromRunnable(r: Runnable | undefined): boolean {
  if (!r) return false
  if (typeof r === 'function') return (r as RunnableMeta)._meta?.rootTriviaClassified === true
  const grammarTrivia = (r._meta as { grammarTrivia?: Combinator<unknown> }).grammarTrivia
  return grammarTrivia?._meta.rootTriviaClassified === true || r._meta.rootTriviaClassified === true
}

function makeSelectedRootLabelIndex(labels: readonly string[]): Readonly<Record<string, number>> {
  const index: Record<string, number> = Object.create(null) as Record<string, number>
  for (let i = 0; i < labels.length; i++) {
    if (index[labels[i]!] === undefined) index[labels[i]!] = i
  }
  return index
}

/** Keep the run-entry closure independent from grammar-construction helpers. */
function runOnce(entry: Runnable, input: string, options: RunOptions): RunResult {
  if (typeof entry !== 'function' && typeof (entry as Combinator<unknown> | undefined)?.parse !== 'function') {
    throw new TypeError(
      `run(): start production is ${entry === null ? 'null' : typeof entry}, not a rule — the requested grammar rule does not exist (check the rule name).`,
    )
  }
  const rootTriviaSelection = options.rootTrivia?.select
  const captureRootTrivia = rootTriviaSelection !== undefined && rootTriviaSelection.length > 0
  const selectedRootLog = captureRootTrivia ? [] as number[] : undefined
  const selectedRootLabelIndex = captureRootTrivia
    ? makeSelectedRootLabelIndex(rootTriviaSelection)
    : undefined
  const errors: ParseError[] = []
  // Grammar-level ambient trivia declared via rules({ trivia }, factory): install
  // it as ctx.trivia so it's ambient for the whole parse (the interpreter path;
  // a compiled entry has it baked in and carries no _meta). parser/noTrivia still
  // override locally.
  const grammarTrivia = typeof entry !== 'function' ? entry._meta.grammarTrivia : undefined
  const grammarScanSkip = typeof entry !== 'function' ? entry._meta.grammarScanSkip : undefined
  const triviaKindLabels = triviaKindLabelsFromRunnable(entry) ?? triviaKindLabelsFromRunnable(options.trivia)
  if (captureRootTrivia && triviaKindLabels === undefined) {
    throw new TypeError('run(): rootTrivia.select requires labeled grammar trivia.')
  }
  if (captureRootTrivia) {
    for (const label of rootTriviaSelection) {
      if (!triviaKindLabels!.includes(label)) {
        throw new TypeError(`run(): rootTrivia.select contains unknown trivia label ${JSON.stringify(label)}.`)
      }
    }
  }
  if (captureRootTrivia
    && !rootTriviaClassifiedFromRunnable(entry)
    && !rootTriviaClassifiedFromRunnable(options.trivia)) {
    throw new TypeError(
      'run(): rootTrivia.select requires classifiedTrivia() at the root.',
    )
  }
  /*
   * Refuse an artifact/host mismatch ONCE per parse, exactly as `parseDoc` and a
   * compiled parser's `parseWithContext` already do. `run()` is handed a RULE, not the
   * registry, so the fused rule functions carry the stamp themselves (see `fusedBody`);
   * an interpreter entry carries it on `_meta`. Neither is on a hot path — this runs
   * once, before `invoke`.
   *
   * Without this, `run()` was the one driver that could silently produce the wrong tree
   * shape: an 'ast' artifact driven with a positioned-CST host returns its own AST
   * objects where the caller asked for a CST, and a CST child filter then drops them
   * and the node simply vanishes.
   *
   * The INTERPRETER passes `elided: false` unconditionally, and that is not a shortcut:
   * it has no compile step, re-decides the host route per parse, and so has never
   * dropped a branch. Only its `'cst'`-without-a-host half can be wrong.
   */
  const stamped = entry as Partial<Record<symbol, unknown>>
  assertHostModeCompatible(
    typeof entry === 'function'
      ? ((stamped[FUSED_HOST_MODE] as HostMode | undefined) ?? 'ast')
      : (entry._meta.grammarHostMode ?? 'ast'),
    options.build,
    typeof entry === 'function' && stamped[FUSED_HOST_ELIDED] === true,
  )
  const ctx: ParseContext = {
    trackLines: false,
    ...(captureRootTrivia
      ? {
          _rootTriviaLog: selectedRootLog!,
          _rootTriviaKindIndex: selectedRootLabelIndex!,
          _rootTriviaStrictScopes: true,
        }
      : {}),
    _errors: errors,
    build: options.build,
    state: options.state,
    ...(grammarTrivia !== undefined
      ? { trivia: grammarTrivia, ...(triviaKindLabels ? { triviaKindLabels } : {}) }
      : triviaKindLabels ? { triviaKindLabels } : {}),
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
    ...(selectedRootLog !== undefined && selectedRootLog.length > 0
      ? {
          rootTrivia: {
            rows: selectedRootLog!,
            select: rootTriviaSelection!,
            index: buildRootTriviaIndex(selectedRootLog!, rootTriviaSelection!),
          },
        }
      : {}),
    unconsumedFrom,
  }
}

/* `RunOptions.profile` — the three-pass profiling boundary (recognizer /
 * structuralCapture / hostConstruction) — is GONE, along with `RunResult.profile`,
 * `RunProfile`, `RunProfilePass`, the `ProfilePhase`/`ProfileState` plumbing and
 * `ParseContext._pmProfile`. The counters it read stopped being emitted into
 * compiled artifacts in 9751cce (profiling is interpreted-mode only: the gates cost
 * a `_ctx._pmProfile` read plus ~15 threaded ternaries on EVERY node), the
 * interpreter never implemented them, and so the option only ever threw. A
 * well-typed call into an unconditional throw is worse than no option at all.
 * What a restoration would take is recorded in
 * `docs/future/bench-typecheck-followups.md`. */

export function run(entry: Runnable, input: string, options: RunOptions = {}): RunResult {
  return guardRemovedFields(runOnce(entry, input, options))
}
