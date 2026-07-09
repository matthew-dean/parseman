import type { Combinator, ParseContext, ParseResult, ParseFail } from '../types.ts'
import { buildLineIndex, annotateSpan } from '../compiler/line-index.ts'
import { markUnusedValues } from '../compiler/value-usage.ts'
import { triviaKindMask } from '../cst/trivia-kinds.ts'

export type ParseOptions = {
  trackLines?: boolean
  /**
   * Enable error recovery. When true, recover() nodes collect their ParseErrors
   * into a side-channel array rather than (only) embedding them in the value tree.
   * The returned ParseOk will have an `errors` field listing all recovered errors.
   * Top-level parse failures (where no recover() node caught the error) still
   * return ParseFail as usual.
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

export function parser<T>(opts: ParserOptions, root: Combinator<T>): ParsemanParser<T> {
  const clearTrivia = opts.trivia === null
  return {
    _tag: 'grammar',
    _meta: root._meta,
    _def: {
      tag: 'grammar',
      parser: root as Combinator<unknown>,
      triviaParser: clearTrivia ? undefined : (opts.trivia ?? undefined),
      clearTrivia,
      trackLines: opts.trackLines ?? false,
    },
    parse(input: string, pos?: number, _ctx?: ParseContext): ParseResult<T> {
      const trackLines = opts.trackLines ?? _ctx?.trackLines ?? false
      // Preserve any CST collectors / capture flag from the caller (e.g. an
      // enclosing node()), layering this grammar's trivia on top. Without this,
      // a parser() nested inside a node() would drop the node's child collectors.
      const ctx: ParseContext = {
        ..._ctx,
        trackLines,
        // trivia: null clears (contiguous terms); a Combinator sets; undefined inherits.
        ...(clearTrivia ? {
          trivia: undefined,
          triviaKindLabels: undefined,
        } : opts.trivia != null ? {
          trivia: opts.trivia,
          ...(opts.trivia._meta.triviaKindLabels
            ? { triviaKindLabels: opts.trivia._meta.triviaKindLabels }
            : {}),
        } : {}),
        ...(opts.captureTrivia || _ctx?.captureTrivia ? { captureTrivia: true } : {}),
        // Kind-filter for per-node capture. Resolve against this scope's trivia
        // labels; falls through (undefined = capture all) without labels.
        ...(opts.captureTriviaKinds && !clearTrivia
          ? { _triviaCaptureMask: triviaKindMask(opts.trivia?._meta.triviaKindLabels, opts.captureTriviaKinds) }
          : {}),
      }
      const result = root.parse(input, pos ?? 0, ctx)
      if (trackLines) {
        const idx = buildLineIndex(input)
        return { ...result, span: annotateSpan(result.span, idx) }
      }
      return result
    },
  } as ParsemanParser<T>
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
  const trackLines = opts.trackLines ?? false
  const _errors = opts.recover ? [] : undefined
  // In recovery mode also track the furthest-position failure, so the caller can
  // report "where it got stuck + what was expected" even when a permissive top
  // rule succeeds with unconsumed trailing input. Off by default (it adds
  // bookkeeping to every failed alternative).
  const _probe = opts.recover ? { offset: input.length, best: null as ParseFail | null } : undefined
  const ctx: ParseContext = {
    trackLines,
    ...(_errors !== undefined ? { _errors } : {}),
    ...(_probe !== undefined ? { _probe } : {}),
  }
  const result = combinator.parse(input, 0, ctx)
  if (!result.ok) return result
  const withErrors = _errors !== undefined
    ? { ...result, errors: _errors, furthestFail: _probe?.best ?? null }
    : result
  if (trackLines) {
    const idx = buildLineIndex(input)
    return { ...withErrors, span: annotateSpan(withErrors.span, idx) }
  }
  return withErrors
}
