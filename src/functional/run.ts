import type { Combinator, ParseContext, ParseError, ParseResult, Span } from '../types.ts'
import { REC } from '../recovery/scan.ts'
import { createParseContext } from '../parse-context.ts'
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
   * parses omit this completely, so instrumentation has no normal-path cost.
   * Table-backed 0.47 artifacts support `_grammarCoverage` but reject
   * `_grammarTrace` explicitly; interpreted/source-lowered entries may support
   * both. */
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
   * The grammar's trivia rule — an OVERRIDE, no longer a requirement.
   *
   * A root rule consumes trivia BETWEEN terms but not after the last one, so
   * trailing whitespace/comments would otherwise look like unparsed input. `run`
   * skips that tail before computing `unconsumedFrom` and before reporting
   * `span`, so only real leftover is reported.
   *
   * The trivia used is the ENTRY's own ambient trivia — whatever
   * `rules({ trivia })` / `parser({ trivia })` declared — resolved automatically
   * (see `ambientTriviaFromRunnable`). Pass this only to use a DIFFERENT trivia
   * for the document tail than the grammar parses with; it wins when given.
   * Passing the grammar's own trivia is now a no-op, and remains supported.
   *
   * Either way it encodes dialect differences for free: CSS trivia leaves a
   * trailing `//` as leftover, Less trivia (which treats `//` as a line comment)
   * does not. An UNTERMINATED comment (which the trivia rule won't match)
   * surfaces at its start.
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
   * left unconsumed (the document's trailing trivia is always skipped; see
   * `RunOptions.trivia`), or null if the whole input was consumed. This is how you
   * detect "the grammar stopped short, there's junk here". Only meaningful on
   * success — a failed parse reports its own `span`/`expected`. */
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
 * `JSON.stringify` and identity digests, so restoring them moves no output —
 * they exist only to answer a read.
 *
 * ## They live on a SHARED PROTOTYPE, and that is the whole point
 *
 * "Costs nothing on the parse path" was ASSERTED here and was FALSE. Until
 * 0.47 every `run()` called a `guardRemovedFields(result)` that ran three
 * `Object.defineProperty` calls — three fresh getter closures, three
 * AccessorPairs, three runtime calls — on the result of EVERY parse. Measured
 * through `bench/ab-harness.ts` (both sides in one process, paired and
 * order-alternated, sides rebuilt per pass, control pair measuring the null):
 * removing it made `run()` **-42% on a 7-byte input and -18% on the 52-byte
 * `SMALL_JSON`**, at 12/12 interleaved pairs in every pass against a null of
 * 48-55%. It is a FIXED cost per run, so it vanishes into the noise by
 * `MEDIUM_JSON` — which is exactly why no size-scaled benchmark ever saw it,
 * and exactly why the smallest parses paid the most.
 *
 * The realised-map count was NOT the mechanism, and saying so matters because
 * that was the first guess: `%HaveSameMap` over 2000 parses read **2** maps,
 * not 2000 — V8 shares the accessor transition even though each result got its
 * own closures. The cost was pure per-parse WORK.
 *
 * A prototype pays it once, at module load, and keeps the notice
 * byte-for-byte. Every property the tests pin is preserved: a read still
 * throws the migration `TypeError`, and non-enumerable prototype accessors are
 * invisible to `Object.keys`, spread and `JSON.stringify` for the same reason
 * non-enumerable own ones were. The one difference is that
 * `Object.getOwnPropertyDescriptor(result, 'triviaLog')` is now `undefined`
 * and the descriptor lives on the prototype — nothing reads these names except
 * a stale consumer, and a stale consumer reads them, it does not describe them.
 *
 * The prototype is attached at CREATION — see `RunResultRecord` below for the
 * measured cost of each way of doing that, and for why "attach a prototype" is
 * not one decision but two.
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
 * The two shapes a `RunResult` comes in, as constructors.
 *
 * TWO, because `rootTrivia` is ABSENT rather than empty when no requested
 * category was retained and that is the contract — `RunResultWithRootTrivia`
 * is not a wider `RunResultRecord`, it is the other case. Assignment order
 * fixes `Object.keys` order, and plain assignment keeps every field an
 * enumerable own property, so both are indistinguishable from the object
 * literals they replace.
 *
 * CONSTRUCTORS rather than literals carrying `__proto__`, and the difference is
 * not stylistic. Measured at 200k allocations of this exact shape, against a
 * plain literal at 7.28 ms: three per-object `Object.defineProperty` calls
 * (what 0.44-0.46 did) cost **105.27 ms**, a `{ __proto__: PROTO, … }` literal
 * **25.58 ms**, and `new` on a constructor whose `.prototype` carries the
 * accessors **8.72 ms**. `__proto__` in a literal is a runtime prototype set,
 * about 91 ns per result; a constructor bakes the prototype into the initial
 * map and costs about 7 ns. Both readings were confirmed end-to-end through
 * `bench/ab-harness.ts` on `run()` itself.
 */
class RunResultRecord {
  declare ok: RunResult['ok']
  declare value: RunResult['value']
  declare span: RunResult['span']
  declare expected: RunResult['expected']
  declare errors: RunResult['errors']
  declare unconsumedFrom: RunResult['unconsumedFrom']

  constructor(
    ok: RunResult['ok'],
    value: RunResult['value'],
    span: RunResult['span'],
    expected: RunResult['expected'],
    errors: RunResult['errors'],
    unconsumedFrom: RunResult['unconsumedFrom'],
  ) {
    this.ok = ok
    this.value = value
    this.span = span
    this.expected = expected
    this.errors = errors
    this.unconsumedFrom = unconsumedFrom
  }
}

class RunResultWithRootTrivia {
  declare ok: RunResult['ok']
  declare value: RunResult['value']
  declare span: RunResult['span']
  declare expected: RunResult['expected']
  declare errors: RunResult['errors']
  declare rootTrivia: RootTriviaCapture
  declare unconsumedFrom: RunResult['unconsumedFrom']

  constructor(
    ok: RunResult['ok'],
    value: RunResult['value'],
    span: RunResult['span'],
    expected: RunResult['expected'],
    errors: RunResult['errors'],
    rootTrivia: RootTriviaCapture,
    unconsumedFrom: RunResult['unconsumedFrom'],
  ) {
    this.ok = ok
    this.value = value
    this.span = span
    this.expected = expected
    this.errors = errors
    this.rootTrivia = rootTrivia
    this.unconsumedFrom = unconsumedFrom
  }
}

/**
 * Install the removed-field notices ONCE, at module load, on both prototypes.
 *
 * Non-enumerable, as they were as own properties, and for the same reason:
 * invisible to `Object.keys`, spread, `JSON.stringify` and identity digests, so
 * restoring the names moves no output. A read still throws the migration.
 */
for (const proto of [RunResultRecord.prototype, RunResultWithRootTrivia.prototype]) {
  for (const [name, detail] of REMOVED_RUN_RESULT_FIELDS) {
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: false,
      get(): never {
        throw new TypeError(
          `RunResult.${name} was REMOVED in parseman 0.44.0 and has no default replacement. ${detail}`,
        )
      },
    })
  }
}

const invoke = (r: Runnable, input: string, pos: number, ctx: ParseContext): ParseResult<unknown> =>
  typeof r === 'function' ? r(input, pos, ctx) : r.parse(input, pos, ctx)

type RunnableMeta = {
  readonly _meta?: {
    readonly triviaKindLabels?: readonly string[]
    readonly rootTriviaClassified?: true
    readonly grammarTrivia?: Runnable
  }
}

/**
 * THE DOCUMENT ROOT OWNS ITS TRAILING TRIVIA, and it is `run()` that decides
 * which rule the document root is.
 *
 * `node({ trailingTrivia })` says the same thing per NODE, and its failure mode
 * is a silent success: of jess's four shipping grammars two set it on
 * `Stylesheet` and two did not, so a comment-only `.jess` document matched
 * ZERO-WIDTH at the root and reported `ok: true` with `unconsumedFrom: 0` — 0 of
 * 124 bytes consumed, no error, every gate green. 1626 of 2409 sass-spec inputs
 * stopped exactly one byte short of the file for the same reason. An option
 * every grammar author must remember, whose cost of forgetting is a parse that
 * claims to have succeeded, is not an option.
 *
 * WHY THIS CANNOT BE A DEFAULT ON `node()`. A block bounded by a closing
 * delimiter must NOT swallow the gap after its closer — that gap belongs to the
 * parent, and handing it to the child mis-attributes trivia in the CST. That is
 * a different silent defect, not a fix. Only the document root has no parent to
 * take it.
 *
 * WHY IT CANNOT BE STAMPED BY `rules()` / `parser()` EITHER, which is the
 * question this defect really turns on. A `rules()` map has many rules and ANY
 * of them can be an entry; `compose()`/`linkable()` pieces bring their own. A
 * rule is not a root — a rule is a root OF A PARSE. `Stylesheet` is the document
 * root when you hand it to `run()`, and an ordinary interior rule when some
 * other rule references it, and BOTH can be true of the same combinator object
 * in the same process. Nothing at grammar-construction time can distinguish
 * those two uses, which is exactly why this was made an opt-in in the first
 * place. `run()` is the one place that knows: it is handed the entry.
 *
 * So there is no stamp and no per-rule flag. A referenced rule runs inside its
 * referencing rule's body, `run()` never sees it, and the enclosing rule keeps
 * ownership of the gap that follows it — unchanged, in every engine.
 *
 * THE THREE PLACES the ambient trivia can live are the same three
 * `triviaKindLabelsFromRunnable` already reads, for the same reason: `rules({
 * trivia }, …)` leaves it on `_meta.grammarTrivia`, `parser({ trivia }, …)`
 * leaves it on `_def.triviaParser`, and a table/compiled entry is a FUNCTION
 * that carries neither, so its rule map stamps `_meta.grammarTrivia` itself
 * (`src/table/stamp.ts`). Reading fewer than three is how one engine's entry
 * silently keeps the old behaviour while the others move.
 */
function ambientTriviaFromRunnable(r: Runnable | undefined): Runnable | undefined {
  if (!r) return undefined
  if (typeof r === 'function') return (r as RunnableMeta)._meta?.grammarTrivia
  // A trivia rule handed in as the entry parses trivia; it has no tail of its own.
  if (r._meta.isTrivia) return undefined
  return (r._meta as { grammarTrivia?: Combinator<unknown> }).grammarTrivia
    ?? (r._def.tag === 'grammar' ? r._def.triviaParser : undefined)
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

/**
 * Extend a result span's END over the document's trailing trivia.
 *
 * A NEW object, never a mutation: the entry's span may be the very object a node
 * already published to the tree, and growing that in place would move a node's
 * span as a side effect of asking the driver a document-level question.
 *
 * When the run tracked lines, `endLine`/`endColumn` are re-derived rather than
 * carried over. Leaving them describing the OLD end while `end` names the new
 * one reports a position that is off by however much trivia the file ends with —
 * the same class of quietly-wrong answer this whole change exists to remove. The
 * scan is over the trailing trivia only, and only when the fields are present,
 * so a run without line tracking does no work at all.
 */
function growSpanEnd(span: Span, input: string, end: number): Span {
  if (span.endLine === undefined || span.endColumn === undefined) {
    return { start: span.start, end }
  }
  let line = span.endLine
  let column = span.endColumn
  for (let i = span.end; i < end; i++) {
    if (input.charCodeAt(i) === 10) { line++; column = 1 } else { column++ }
  }
  return { ...span, end, endLine: line, endColumn: column }
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
  // ONE shape, every configuration. These were six conditional spreads; see
  // `createParseContext` for why that is a hidden-class hazard on the object
  // every combinator reads. Assignments below are in-object stores to slots that
  // already exist, so none of them transitions the map.
  const ctx = createParseContext()
  if (captureRootTrivia) {
    ctx._rootTriviaLog = selectedRootLog!
    ctx._rootTriviaKindIndex = selectedRootLabelIndex!
    ctx._rootTriviaStrictScopes = true
  }
  ctx._errors = errors
  ctx.build = options.build
  ctx.state = options.state
  if (grammarTrivia !== undefined) ctx.trivia = grammarTrivia
  if (triviaKindLabels) ctx.triviaKindLabels = triviaKindLabels
  if (grammarScanSkip !== undefined) ctx.scanSkip = grammarScanSkip
  if (options.triviaCaptureMask !== undefined) ctx._triviaCaptureMask = options.triviaCaptureMask
  if (options.tolerant) {
    ctx._tolerant = true
    ctx._rec = REC
  }
  if (options.instrumentation !== undefined) {
    ctx._grammarCoverage = options.instrumentation._grammarCoverage
    ctx._grammarTrace = options.instrumentation._grammarTrace
  }
  const r = invoke(entry, input, 0, ctx)

  const value = r.ok ? (r as { value: unknown }).value : undefined
  let span = r.span ?? { start: 0, end: 0 }
  const expected = r.ok ? [] : ((r as { expected?: string[] }).expected ?? [])

  let unconsumedFrom: number | null = null
  if (r.ok) {
    let pos = span.end
    // The root's trailing trivia — see `ambientTriviaFromRunnable`. `options.trivia`
    // wins because it is an explicit request to measure the tail with a DIFFERENT
    // trivia than the grammar parses with.
    const tail = options.trivia ?? ambientTriviaFromRunnable(entry)
    if (tail !== undefined && pos < input.length) {
      // Throwaway ctx: trailing trivia must NOT pollute the parse's trivia log.
      // This is a POSITION question, and the root's per-node trivia log is the
      // separate, node-scoped answer that `node({ trailingTrivia })` gives.
      const t = invoke(tail, input, pos, createParseContext())
      if (t.ok && t.span.end > pos) {
        span = growSpanEnd(span, input, t.span.end)
        pos = t.span.end
      }
    }
    unconsumedFrom = pos < input.length ? pos : null
  }

  // `rootTrivia` is ABSENT rather than empty when no requested category was
  // retained, so branch on it — do not index into it. The branch is spelled as
  // two constructors rather than one literal with a
  // `...(cond ? { rootTrivia } : {})` spread: the two arms produce exactly the
  // two shapes the contract calls for, which is what the spread was silently
  // doing anyway, and a conditional spread is the shape hazard this repo has
  // an incident over.
  return selectedRootLog !== undefined && selectedRootLog.length > 0
    ? new RunResultWithRootTrivia(
        r.ok,
        value,
        span,
        expected,
        errors,
        {
          rows: selectedRootLog,
          select: rootTriviaSelection!,
          index: buildRootTriviaIndex(selectedRootLog, rootTriviaSelection!),
        },
        unconsumedFrom,
      )
    : new RunResultRecord(r.ok, value, span, expected, errors, unconsumedFrom)
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
  return runOnce(entry, input, options)
}
