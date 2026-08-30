import type { Combinator, ParseContext, ParseResult, ParseFail, ParseError } from '../types.ts'
import { createLineIndex, recordLineRange, normalizeLineIndex, annotateSpan, type LineIndex } from '../line-index.ts'
import { markUnusedValues } from '../compiler/value-usage.ts'
import { triviaKindMask } from '../cst/trivia-kinds.ts'
import { refuseUnclassifiedRootScope } from '../cst/root-trivia-scope.ts'
import { createParseContext } from '../parse-context.ts'
import { scalarOf, scalarRootOf, type ScalarParser } from './scalar.ts'

export type ParseOptions = {
  trackLines?: boolean
  /**
   * Enable the error-collection channel. When true, recovery points (expect(), and
   * tolerant list recovery) collect their ParseErrors into a side-channel array
   * rather than only embedding them in the value tree. The returned ParseOk will
   * have an `errors` field listing all recovered errors. Top-level parse failures
   * (where nothing recovered) still return ParseFail as usual.
   */
  recover?: boolean
}

export type ParserOptions = ParseOptions & {
  /**
   * Trivia parser for this scope. Three states:
   *   - a Combinator → skip this trivia between sequence/repeat terms
   *   - `undefined`  → inherit the enclosing scope's trivia (no change)
   *   - `null`       → CLEAR trivia: no trivia skipped, so terms must be contiguous.
   *                    Re-enable inside a nested region with another parser({ trivia }).
   */
  trivia?: Combinator<unknown> | null
  /**
   * Declare that this local trivia scope intentionally does not preserve
   * selected root categories. Required only by
   * `rootTrivia: { select }` when the scope does not use
   * `classifiedTrivia()`.
   */
  rootCapture?: 'opaque'
  /** Record consumed trivia as CSTTrivia tokens in rawChildren. Default: skip. */
  captureTrivia?: boolean
  /**
   * Restrict PER-NODE CST trivia capture to these trivia kinds (label names from
   * the trivia's `label()` arms). Whitespace and any other unlisted kind is still
   * skipped over but NOT recorded into a node's `triviaLog` — so a host that only
   * consumes (say) comments pays nothing to log every whitespace run. The global
   * trivia log is unaffected. Requires labeled trivia; ignored otherwise.
   */
  captureTriviaKinds?: readonly string[]
}

export interface ParsemanParser<T> extends Combinator<T> {
  parse(input: string): ParseResult<T>
  parse(input: string, pos: number, ctx: ParseContext): ParseResult<T>
}

function annotateResultLines<T, R extends ParseResult<T>>(result: R, index: LineIndex): R {
  const annotated = { ...result, span: annotateSpan(result.span, index) } as R
  const errors = (annotated as { errors?: ParseError[] }).errors
  if (errors) {
    ;(annotated as { errors: ParseError[] }).errors = errors.map(error => ({
      ...error,
      span: annotateSpan(error.span, index),
    }))
  }
  return annotated
}

function createParseLineContext(input: string, pos: number): { lineIndex: LineIndex; lineScannedTo: number } {
  const lineIndex = createLineIndex()
  if (pos > 0) recordLineRange(lineIndex, input, 0, pos)
  return { lineIndex, lineScannedTo: pos }
}

/** The three pre-written `trackLines` resolvers. One is SELECTED at link time. */
const TRACK_LINES_ON = (): boolean => true
const TRACK_LINES_OFF = (): boolean => false
const TRACK_LINES_INHERIT = (ctx: ParseContext | undefined): boolean => ctx?.trackLines === true

/**
 * A trivia scope.
 *
 * ── NO RULE MAY CONSULT AN OPTION WHILE IT PARSES ───────────────────────────
 *
 * `opts` is fixed when `parser(opts, root)` is called. That is LINK TIME — the
 * same moment `assemble.ts` resolves `RunCfg` into a choice of piece, and the
 * same rule (`RunCfg`'s header, `scripts/check-invariants.mjs` INV-6/INV-7).
 * Everything below used to be read INSIDE `parse`, which a nested scope enters
 * on every visit, so a grammar with a `parser({ trivia })` region paid nine
 * option reads per entry for answers that could not change.
 *
 * They are now resolved once, here, and the parse path reads only the resolved
 * values. Where the answer genuinely depends on the CALLER's context — an
 * inherited `trackLines`, inherited trivia labels — a pre-written variant is
 * SELECTED at link time rather than branched on per entry. Selecting costs one
 * closure per scope in the grammar; branching cost one test per entry per parse.
 *
 * `_ctx.trivia`, `_ctx.captureTrivia` and the CST sinks stay where they are:
 * those are per-scope RUNTIME state that `node()` opens and closes mid-parse,
 * not configuration. Resolving them early would be wrong, not fast.
 */
export function parser<T>(opts: ParserOptions, root: Combinator<T>): ParsemanParser<T> {
  const clearTrivia = opts.trivia === null
  const opaqueRootCapture = opts.rootCapture === 'opaque'
  if (opaqueRootCapture && opts.trivia === undefined) {
    throw new TypeError('parser({ rootCapture: \'opaque\' }) requires an explicit trivia scope.')
  }
  /** This scope's own trivia, or `undefined` for cleared/inherited. */
  const scopeTrivia: Combinator<unknown> | undefined = clearTrivia ? undefined : (opts.trivia ?? undefined)
  /**
   * `?._meta?.` and not `?._meta.`: the macro's own evaluator builds a
   * `parser({ trivia: /re/ })` from source text, so a raw RegExp reaches here.
   * The reads used to happen inside `parse`, where such a scope threw only if it
   * ever ran; hoisting them to construction must not turn that into a build-time
   * throw. (`test/unit/plugin-coverage.test.ts`, "anyValue edge forms".)
   */
  const scopeLabels = scopeTrivia?._meta?.triviaKindLabels
  /** Does this scope have to refuse an unclassified root scope? Link-time fact. */
  const refuseUnclassified = scopeTrivia !== undefined
    && !scopeTrivia._meta?.rootTriviaClassified && !opaqueRootCapture
  const forceCaptureTrivia = opts.captureTrivia === true
  const trackLinesPolicy = opts.trackLines === true ? 'on'
    : opts.trackLines === false ? 'off' : 'inherit'
  const trackLinesOf = trackLinesPolicy === 'on' ? TRACK_LINES_ON
    : trackLinesPolicy === 'off' ? TRACK_LINES_OFF
    : TRACK_LINES_INHERIT
  /**
   * The per-node capture mask, resolved as far as this scope can resolve it.
   *
   * With its own labelled trivia the mask is a constant and is computed once.
   * With INHERITED labels it depends on the caller, so the link step selects the
   * deriving variant instead — `undefined` here means "no mask to install".
   */
  const captureKinds = clearTrivia ? undefined : opts.captureTriviaKinds
  const ownCaptureMask = captureKinds === undefined ? undefined
    : scopeLabels !== undefined ? triviaKindMask(scopeLabels, captureKinds)
    : undefined
  const inheritCaptureMask = captureKinds !== undefined && scopeLabels === undefined
  const rootScalar = scalarOf(root)
  const scalarEligible = opts.trackLines !== true && opts.recover !== true
    && !opaqueRootCapture && !forceCaptureTrivia && captureKinds === undefined
  const parseScalar = scalarEligible
    ? (input: string, pos: number, ctx: ParseContext): number => {
        const savedTrivia = ctx.trivia
        const savedLabels = ctx.triviaKindLabels
        if (clearTrivia) {
          ctx.trivia = undefined
          ctx.triviaKindLabels = undefined
        } else if (scopeTrivia !== undefined) {
          ctx.trivia = scopeTrivia
          ctx.triviaKindLabels = scopeLabels
        }
        const end = rootScalar(input, pos, ctx)
        ctx.trivia = savedTrivia
        ctx.triviaKindLabels = savedLabels
        return end
      }
    : undefined
  let publicScalar: ScalarParser | null | undefined
  const grammar: ParsemanParser<T> = {
    _tag: 'grammar',
    _meta: {
      ...root._meta,
      // Trivia classification describes this grammar's own active trivia
      // scope. A directly nested grammar may have classified trivia of its
      // own, but that must not advertise classification for this wrapper.
      triviaKindLabels: undefined,
      rootTriviaClassified: undefined,
      ...(opts.trivia?._meta?.triviaKindLabels ? { triviaKindLabels: opts.trivia._meta.triviaKindLabels } : {}),
      ...(opts.trivia?._meta?.rootTriviaClassified ? { rootTriviaClassified: true as const } : {}),
    },
    _def: {
      tag: 'grammar',
      parser: root as Combinator<unknown>,
      triviaParser: scopeTrivia,
      clearTrivia,
      ...(opaqueRootCapture ? { rootCapture: 'opaque' as const } : {}),
      ...(opts.captureTrivia ? { captureTrivia: true } : {}),
      trackLines: opts.trackLines ?? false,
      constructionTrackLines: trackLinesPolicy,
      ...(captureKinds === undefined ? {} : { constructionCaptureTriviaKinds: captureKinds }),
    },
    _parseScalar: parseScalar,
    parse(input: string, pos?: number, _ctx?: ParseContext): ParseResult<T> {
      if (pos === undefined && _ctx === undefined) {
        publicScalar ??= scalarRootOf(grammar) ?? null
        if (publicScalar) {
          const ctx = createParseContext()
          const end = publicScalar(input, 0, ctx)
          if (end < 0) {
            const at = ~end
            return { ok: false, expected: ctx._fx ?? [], span: { start: at, end: at } }
          }
          return { ok: true, value: ctx._sv as T, span: { start: 0, end } }
        }
      }
      if (refuseUnclassified) refuseUnclassifiedRootScope(_ctx?._rootTriviaStrictScopes)
      const trackLines = trackLinesOf(_ctx)
      const lineContext = trackLines && _ctx?._lineIndex === undefined && _ctx?._lineStarts === undefined
        ? createParseLineContext(input, pos ?? 0)
        : undefined
      const lineIndex = trackLines
        ? (_ctx?._lineIndex ?? (_ctx?._lineStarts ? { lineStarts: _ctx._lineStarts } : lineContext!.lineIndex))
        : undefined
      // Preserve any CST collectors / capture flag from the caller (e.g. an
      // enclosing node()), layering this grammar's trivia on top. Without this,
      // a parser() nested inside a node() would drop the node's child collectors.
      // Inheriting copy, then STORES — see `createParseContext`. `{ ..._ctx }`
      // preserves the canonical shape because `_ctx` already has it, and the
      // overrides below only touch slots that already exist.
      const ctx: ParseContext = _ctx === undefined ? createParseContext() : { ..._ctx }
      ctx.trackLines = trackLines
      if (lineIndex) ctx._lineIndex = lineIndex
      if (lineContext) ctx._lineScannedTo = lineContext.lineScannedTo
      // trivia: null clears (contiguous terms); a Combinator sets; undefined inherits.
      if (clearTrivia) {
        ctx.trivia = undefined
        ctx.triviaKindLabels = undefined
      } else if (scopeTrivia !== undefined) {
        ctx.trivia = scopeTrivia
        if (scopeLabels) ctx.triviaKindLabels = scopeLabels
      }
      if (forceCaptureTrivia || _ctx?.captureTrivia) ctx.captureTrivia = true
      // Kind-filter for per-node capture. Resolve against this scope's trivia
      // labels — this parser's own trivia if it declares one, else the INHERITED
      // labels (`_ctx.triviaKindLabels`), so captureTriviaKinds still applies when
      // trivia is inherited rather than re-declared here. No labels → undefined
      // (capture all).
      if (ownCaptureMask !== undefined) ctx._triviaCaptureMask = ownCaptureMask
      else if (inheritCaptureMask) ctx._triviaCaptureMask = triviaKindMask(_ctx?.triviaKindLabels, captureKinds)
      // This is a property of the local trivia scope, not a post-parse filter:
      // nested recognition can still skip its trivia, but selected root rows
      // must never be written for an explicitly opaque region.
      if (opaqueRootCapture) ctx._rootTriviaCapture = false
      const result = root.parse(input, pos ?? 0, ctx)
      if (trackLines && _ctx && ctx._lineScannedTo !== undefined) {
        _ctx._lineScannedTo = Math.max(_ctx._lineScannedTo ?? 0, ctx._lineScannedTo)
      }
      return lineIndex ? annotateResultLines(result, normalizeLineIndex(lineIndex)) : result
    },
  } as ParsemanParser<T>
  return grammar
}

/**
 * Run `root` with the active trivia cleared — no trivia is skipped between its
 * sequence/repeat terms, so they must be contiguous in the input. (Trivia is
 * whatever parser({ trivia }) installed — often whitespace/comments, but it is
 * grammar-defined.) The inverse of parser({ trivia }); re-enable trivia in a
 * nested region with another parser({ trivia }).
 *
 * Wrap the WHOLE contiguous run: an enclosing sequence skips trivia *before* a
 * term runs, so wrapping just the inner part would let leading trivia through.
 *
 * For a static glued token just use one literal/regex; reach for noTrivia when a
 * glued part is a structured sub-rule — e.g. a head glued to a `[subscript]`
 * whose interior still allows trivia. Turn trivia back on for a region by nesting
 * another parser({ trivia }) (innermost wins, reverts on exit); put the WHOLE
 * spaced region — including its leading `[` — inside it, since sequence skips
 * trivia only between terms, not before its first:
 *
 *   // `arr[i + 1]` — `arr` touches `[`, but the subscript is a spaced expr:
 *   noTrivia(sequence(name,
 *     parser({ trivia: ws }, sequence(literal('['), expr, literal(']')))))
 */
export function noTrivia<T>(root: Combinator<T>): ParsemanParser<T> {
  return parser({ trivia: null }, root)
}

// Roots already run through dead-value analysis, so a hot parse loop doesn't
// re-walk the tree. (A `rules()` grammar was analyzed at build; a bare combinator
// passed straight to parse() is analyzed once here.)
const _analyzed = new WeakSet<Combinator<unknown>>()

export function parse<T>(
  combinator: Combinator<T>,
  input: string,
  opts: ParseOptions = {}
): ParseResult<T> {
  if (!_analyzed.has(combinator)) {
    _analyzed.add(combinator)
    markUnusedValues(combinator)
  }
  if (!opts.trackLines && !opts.recover && combinator._def.tag === 'grammar'
    && combinator._meta.grammarScanSkip === undefined) {
    return (combinator as ParsemanParser<T>).parse(input)
  }
  const trackLines = opts.trackLines ?? combinator._meta.grammarTrackLines ?? false
  const lineContext = trackLines ? createParseLineContext(input, 0) : undefined
  const lineIndex = lineContext?.lineIndex
  const _errors = opts.recover ? [] : undefined
  // In recovery mode also track the furthest-position failure, so the caller can
  // report "where it got stuck + what was expected" even when a permissive top
  // rule succeeds with unconsumed trailing input. Off by default (it adds
  // bookkeeping to every failed alternative).
  const _probe = opts.recover ? { offset: input.length, best: null as ParseFail | null } : undefined
  // Grammar-level ambient trivia declared via rules({ trivia }, factory): install
  // it as ctx.trivia so it's ambient (interpreter). parser/noTrivia override locally.
  const grammarTrivia = combinator._meta.grammarTrivia
  const grammarScanSkip = combinator._meta.grammarScanSkip
  // ONE shape — see `createParseContext`. Stores, not conditional spreads.
  const ctx = createParseContext()
  ctx.trackLines = trackLines
  if (lineIndex) ctx._lineIndex = lineIndex
  if (lineContext) ctx._lineScannedTo = lineContext.lineScannedTo
  if (grammarTrivia !== undefined) {
    ctx.trivia = grammarTrivia
    if (grammarTrivia._meta.triviaKindLabels) ctx.triviaKindLabels = grammarTrivia._meta.triviaKindLabels
  }
  if (grammarScanSkip !== undefined) ctx.scanSkip = grammarScanSkip
  if (_errors !== undefined) ctx._errors = _errors
  if (_probe !== undefined) ctx._probe = _probe
  const result = combinator.parse(input, 0, ctx)
  if (!result.ok) return lineIndex ? annotateResultLines(result, normalizeLineIndex(lineIndex)) : result
  const withErrors = _errors !== undefined
    ? { ...result, errors: _errors, furthestFail: _probe?.best ?? null }
    : result
  return lineIndex ? annotateResultLines(withErrors, normalizeLineIndex(lineIndex)) : withErrors
}
