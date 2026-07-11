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
 *   word('true')              // matches "true" but not "trueish"
 *   word('color', 'A-Za-z-') // CSS-style identifier boundary
 */
export function word(str: string, boundary = '_0-9A-Za-z'): Combinator<string> {
  return keywords([str], { boundary })
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
  const flags = opts.caseInsensitive ? 'iuy' : 'uy'
  const re = new RegExp(`(?:${alt})${boundary}`, flags)

  // First-set: the set of first code points across all keywords (and their
  // case-folded variants when case-insensitive), for choice() dispatch.
  let firstSet: FirstSet = empty()
  for (const w of sorted) {
    if (w.length === 0) continue
    const cp = w.codePointAt(0)!
    firstSet = union(firstSet, fromChar(cp))
    if (opts.caseInsensitive) {
      const u = String.fromCodePoint(cp).toUpperCase().codePointAt(0)
      const l = String.fromCodePoint(cp).toLowerCase().codePointAt(0)
      if (u !== undefined) firstSet = union(firstSet, fromChar(u))
      if (l !== undefined) firstSet = union(firstSet, fromChar(l))
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
