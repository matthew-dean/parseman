import type { Combinator, ParseContext, ParseResult, ParserMeta, FirstSet } from '../types.ts'
import { fromChar, union, empty } from './first-set.ts'
import { caseFoldVariants } from './case-fold.ts'
import { failAt } from './probe.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'
import { directTerminalFailureExpected } from './expected.ts'
import type { ScalarParser } from './scalar.ts'

export type KeywordsOptions = {
  /** Match case-insensitively. */
  caseInsensitive?: boolean
  /**
   * Character class (regex source, e.g. `'A-Za-z0-9_-'`) that must NOT follow a
   * match — a word boundary. Prevents matching `red` inside `redish`.
   */
  boundary?: string
}

export type WordOptions = Omit<KeywordsOptions, 'boundary'>

/**
 * Match a single keyword with an automatic word-boundary guard. Prevents
 * matching `true` inside `trueish`. The boundary defaults to `_0-9A-Za-z`,
 * which covers most programming-language identifiers.
 *
 *   word('true')                                    // matches "true" but not "trueish"
 *   word('color', 'A-Za-z-')                        // CSS-style identifier boundary
 *   word('media', 'A-Za-z0-9_-', { caseInsensitive: true })
 *   word('media', { caseInsensitive: true })        // default boundary + options
 *
 * `caseInsensitive` matches `keywords()` and exists because it is REQUIRED, not a
 * nicety: CSS at-keywords, function names and units are ASCII case-insensitive per
 * spec (CSS Syntax §3). Without it the only conforming spellings were
 * `regex(/media/i)` — which `analyzeGating` correctly flags as the `keyword-regex`
 * anti-pattern — or `keywords(['media'], …)` for a single word.
 */
export function word(str: string, boundary?: string, opts?: WordOptions): Combinator<string>
export function word(str: string, opts: WordOptions): Combinator<string>
export function word(
  str: string,
  boundaryOrOpts?: string | WordOptions,
  opts?: WordOptions,
): Combinator<string> {
  const boundary = typeof boundaryOrOpts === 'string' ? boundaryOrOpts : '_0-9A-Za-z'
  const rest = typeof boundaryOrOpts === 'object' && boundaryOrOpts !== null ? boundaryOrOpts : opts
  return keywords([str], { ...rest, boundary })
}

/**
 * Create a keyword factory with a fixed word-boundary class. Use when many
 * keywords share the same boundary (e.g. CSS identifiers). For a single keyword,
 * `word(str, boundary?)` is enough.
 *
 *   const kw = makeWord()                                      // default boundary
 *   const cssKw = makeWord('A-Za-z0-9_-', { caseInsensitive: true })
 *
 *   const query = kw('query')
 *   const color = cssKw('color')                               // matches "COLOR" but not "color-scheme"
 */
export function makeWord(boundary?: string, opts?: WordOptions): (str: string) => Combinator<string>
export function makeWord(opts: WordOptions): (str: string) => Combinator<string>
export function makeWord(
  boundaryOrOpts: string | WordOptions = '_0-9A-Za-z',
  opts?: WordOptions,
): (str: string) => Combinator<string> {
  const boundary = typeof boundaryOrOpts === 'string' ? boundaryOrOpts : '_0-9A-Za-z'
  const rest = typeof boundaryOrOpts === 'object' && boundaryOrOpts !== null ? boundaryOrOpts : opts
  return (str: string) => keywords([str], { ...rest, boundary })
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The terminal's one canonical recognizer spelling. Table-selected lexical
 * bodies call this at construction time so the authored parser, CHARACTER row,
 * and TOKEN replacement cannot drift on alternation order, boundary, or flags. */
export function keywordsRegExp(
  words: readonly string[],
  boundary: string | undefined,
  caseInsensitive: boolean,
): RegExp {
  const alt = words.map(escapeRe).join('|')
  const boundarySource = boundary ? `(?![${boundary}])` : ''
  return new RegExp(`(?:${alt})${boundarySource}`, caseInsensitive ? 'iy' : 'uy')
}

/**
 * Match any one of a set of fixed keywords, longest-first (so `border` wins over
 * `bord`), with an optional trailing word-boundary guard. Compiles to a single
 * sticky regex — far less error-prone than a hand-maintained alternation, and
 * the common case (keyword sets: CSS colors, units, at-rule names, HTML tags).
 *
 *   keywords(CSS_COLOR_NAMES, { caseInsensitive: true, boundary: 'A-Za-z0-9_-' })
 *
 * On success the matched text is recorded as a CSTLeaf (like literal()/regex()).
 */
export function keywords(words: readonly string[], opts: KeywordsOptions = {}): Combinator<string> {
  // Longest-first keeps the alternation greedy-correct (regex alternation is
  // first-match, not longest-match).
  const sorted = [...new Set(words)].sort((a, b) => b.length - a.length)
  // Case-INSENSITIVE drops `u` deliberately, so that MATCHING and the first-set
  // below fold the SAME set of characters — the invariant `regex()` established in
  // 0.32.0 (see the flag-aware widening in `src/combinators/regex.ts`):
  //   - `/i` WITHOUT `u` folds only pairs that stay on the SAME side of the ASCII
  //     boundary — every Basic-Latin pair (a↔A … z↔Z), and also the non-ASCII ones
  //     (ä↔Ä, σ↔Σ↔ς), but never a pair that crosses it. `caseFoldVariants` below
  //     enumerates exactly that relation → the first-set is a tight, SOUND superset
  //     and dispatch stays exact. (Widening by toUpperCase/toLowerCase alone would
  //     NOT be: 67 BMP code points sit in fold classes those two miss.)
  //   - `/iu` folds by Unicode *simple case folding*, so `/(?:stroke)/iu` also
  //     matches `ſtroke` (U+017F → s). An ASCII-only first-set would then dispatch
  //     that input AWAY from this arm — an unsound gate. `regex()` answers that by
  //     falling back to `any()` (forfeiting the gate); `keywords()` answers it by
  //     not entering Unicode mode at all, which keeps the gate.
  // Every keyword is fully escaped by `escapeRe`, so `u` mode changes nothing about
  // what a case-SENSITIVE set matches; that path keeps `u` unchanged.
  const re = keywordsRegExp(sorted, opts.boundary, opts.caseInsensitive ?? false)

  // First-set: the set of first code points across all keywords (and their
  // case-folded variants when case-insensitive), for choice() dispatch.
  //
  // The fold must cover the SAME pairs the `iy` matcher above accepts, or the gate
  // dispatches valid input away from this arm. `/i` folds non-ASCII pairs too
  // (`/ärger/i` matches `Ärger`, `/σ/i` matches both `Σ` and `ς`) — it only refuses
  // folds that would CROSS the ASCII boundary. `caseFoldVariants` is that exact
  // relation, so the widening stays a tight, sound superset for every first char,
  // not just the Basic-Latin ones.
  let firstSet: FirstSet = empty()
  for (const w of sorted) {
    if (w.length === 0) continue
    const cp = w.codePointAt(0)!
    firstSet = union(firstSet, fromChar(cp))
    if (opts.caseInsensitive) {
      for (const v of caseFoldVariants(cp)) firstSet = union(firstSet, fromChar(v))
    }
  }

  const meta: ParserMeta = { firstSet, canMatchNewline: false, isTrivia: false }
  const def = {
    tag: 'keywords', words: sorted,
    caseInsensitive: opts.caseInsensitive ?? false,
    boundary: opts.boundary,
  } as const
  const expected = directTerminalFailureExpected(def)
  const parseScalar: ScalarParser = (input, pos, ctx) => {
    re.lastIndex = pos
    const m = re.exec(input)
    if (m === null) {
      ctx._fx = expected
      return ~pos
    }
    ctx._sv = m[0]!
    return pos + m[0]!.length
  }

  return {
    _tag: 'keywords',
    _meta: meta,
    _def: def,
    _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      re.lastIndex = pos
      const m = re.exec(input)
      if (m === null) return failAt(ctx, directTerminalFailureExpected(def), pos)
      const value = m[0]!
      const span = { start: pos, end: pos + value.length }
      if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value, span })
      return { ok: true, value, span }
    },
  }
}
