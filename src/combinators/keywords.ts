import type { Combinator, ParseContext, ParseResult, ParserMeta, FirstSet } from '../types.ts'
import { fromChar, union, empty } from './first-set.ts'
import { failAt } from './probe.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'

export type KeywordsOptions = {
  /** Match case-insensitively. */
  caseInsensitive?: boolean
  /**
   * Character class (regex source, e.g. `'A-Za-z0-9_-'`) that must NOT follow a
   * match — a word boundary. Prevents matching `red` inside `redish`.
   */
  boundary?: string
}

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
export function word(str: string, boundary?: string, opts?: Omit<KeywordsOptions, 'boundary'>): Combinator<string>
export function word(str: string, opts: Omit<KeywordsOptions, 'boundary'>): Combinator<string>
export function word(
  str: string,
  boundaryOrOpts?: string | Omit<KeywordsOptions, 'boundary'>,
  opts?: Omit<KeywordsOptions, 'boundary'>,
): Combinator<string> {
  const boundary = typeof boundaryOrOpts === 'string' ? boundaryOrOpts : '_0-9A-Za-z'
  const rest = typeof boundaryOrOpts === 'object' && boundaryOrOpts !== null ? boundaryOrOpts : opts
  return keywords([str], { ...rest, boundary })
}

/**
 * Create a keyword factory with a fixed word-boundary class. Use when many
 * keywords share the same boundary (e.g. CSS identifiers). For a single keyword,
 * `word(str, boundary?)` is enough; you can also roll your own factory with
 * `(s) => word(s, boundary)`.
 *
 *   const kw = makeWord()                    // default: '_0-9A-Za-z'
 *   const cssKw = makeWord('A-Za-z0-9_-')    // dashes allowed in CSS idents
 *
 *   const query = kw('query')
 *   const color = cssKw('color')             // matches "color" but not "color-scheme"
 */
export function makeWord(boundary = '_0-9A-Za-z'): (str: string) => Combinator<string> {
  return (str: string) => keywords([str], { boundary })
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
  const alt = sorted.map(escapeRe).join('|')
  const boundary = opts.boundary ? `(?![${opts.boundary}])` : ''
  // Case-INSENSITIVE drops `u` deliberately, so that MATCHING and the first-set
  // below fold the SAME set of characters — the invariant `regex()` established in
  // 0.32.0 (see the flag-aware widening in `src/combinators/regex.ts`):
  //   - `/i` WITHOUT `u` folds only the ASCII Basic-Latin pairs (a↔A … z↔Z), which
  //     is exactly what the ASCII fold below enumerates → the first-set is a tight,
  //     SOUND superset and dispatch stays exact.
  //   - `/iu` folds by Unicode *simple case folding*, so `/(?:stroke)/iu` also
  //     matches `ſtroke` (U+017F → s). An ASCII-only first-set would then dispatch
  //     that input AWAY from this arm — an unsound gate. `regex()` answers that by
  //     falling back to `any()` (forfeiting the gate); `keywords()` answers it by
  //     not entering Unicode mode at all, which keeps the gate.
  // Every keyword is fully escaped by `escapeRe`, so `u` mode changes nothing about
  // what a case-SENSITIVE set matches; that path keeps `u` unchanged.
  const flags = opts.caseInsensitive ? 'iy' : 'uy'
  const re = new RegExp(`(?:${alt})${boundary}`, flags)

  // First-set: the set of first code points across all keywords (and their
  // ASCII case-folded variants when case-insensitive), for choice() dispatch.
  let firstSet: FirstSet = empty()
  for (const w of sorted) {
    if (w.length === 0) continue
    const cp = w.codePointAt(0)!
    firstSet = union(firstSet, fromChar(cp))
    if (opts.caseInsensitive && cp < 128) {
      const u = String.fromCodePoint(cp).toUpperCase().codePointAt(0)
      const l = String.fromCodePoint(cp).toLowerCase().codePointAt(0)
      if (u !== undefined && u < 128) firstSet = union(firstSet, fromChar(u))
      if (l !== undefined && l < 128) firstSet = union(firstSet, fromChar(l))
    }
  }

  const meta: ParserMeta = { firstSet, canMatchNewline: false, isTrivia: false }

  return {
    _tag: 'keywords',
    _meta: meta,
    _def: { tag: 'keywords', words: sorted, caseInsensitive: opts.caseInsensitive ?? false, boundary: opts.boundary },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      re.lastIndex = pos
      const m = re.exec(input)
      if (m === null || m.index !== pos) {
        return failAt(ctx, ['keyword'], pos)
      }
      const value = m[0]!
      const span = { start: pos, end: pos + value.length }
      if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value, span })
      return { ok: true, value, span }
    },
  }
}
