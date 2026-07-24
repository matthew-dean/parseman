import type { Combinator, ParseContext, ParseResult, ParserMeta, FirstSet } from '../types.ts'
import { any } from './first-set.ts'
import { failAt } from './probe.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'
import { shorthandRanges, parseClassRanges } from '../regex/classes.ts'

/**
 * Computes a regex terminal's first-set (for choice-dispatch fast paths). The
 * implementation — `firstSetFromRegex` in `../regex/first-set.ts` — is a small,
 * dependency-free hand-rolled regex parser, registered by the interpreter/library
 * entry (`index.ts`) via `registerRegexAnalyzer`. It is injected rather than
 * imported so that consumers who import `regex` directly from this subpath (no
 * library entry) never pull the analyzer into their bundle at all. When no
 * analyzer is registered, `regex()` uses the permissive fallback below — this
 * only disables the dispatch fast paths, never changing matches.
 */
export type RegexFirstSetAnalyzer = (pattern: string) => { firstSet: FirstSet; canMatchNewline: boolean }

let firstSetAnalyzer: RegexFirstSetAnalyzer | null = null

export function registerRegexAnalyzer(analyzer: RegexFirstSetAnalyzer): void {
  firstSetAnalyzer = analyzer
}

/** Fallback when no analyzer is registered: "could start with any char / could
 * match a newline" — the same conservative value `firstSetFromRegex` returns on
 * an unparseable pattern, so a missing analyzer degrades to "no fast path", not
 * a wrong one. */
const permissiveFirstSet: RegexFirstSetAnalyzer = () => ({ firstSet: any(), canMatchNewline: true })

const SCAN_BAIL_AT = 64
type ShortScanner = (input: string, pos: number) => number | null | undefined

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (let i = 0; i < ranges.length; i++) {
    const [lo, hi] = ranges[i]!
    if (cp >= lo && cp <= hi) return true
  }
  return false
}

/**
 * The positive char-class body (chars between `[` and `]`) as ranges for the
 * short-scan fast path, or null if it can't be lowered — including a NEGATED
 * class (`[^…]`), which the scan can't express. The class parsing itself is the
 * shared `parseClassRanges` (see `../regex/classes.ts`).
 */
function readClassRanges(body: string): Array<[number, number]> | null {
  if (body.startsWith('^')) return null
  return parseClassRanges(body)
}

function shortScanner(source: string, flags: string): ShortScanner | null {
  if (/[imsuvy]/.test(flags)) return null
  let ranges: Array<[number, number]> | null = null
  let quant = ''
  if (source[0] === '[') {
    let end = 1
    while (end < source.length && source[end] !== ']') {
      if (source[end] === '\\') end += 2
      else end++
    }
    if (source[end] !== ']') return null
    ranges = readClassRanges(source.slice(1, end))
    quant = source.slice(end + 1)
  } else if (source[0] === '\\' && (source[1] === 'd' || source[1] === 'w' || source[1] === 's')) {
    ranges = shorthandRanges(source[1])
    quant = source.slice(2)
  }
  if (!ranges || (quant !== '+' && quant !== '*')) return null
  const minOne = quant === '+'
  return (input, pos) => {
    let end = pos
    while (end < input.length && inRanges(input.charCodeAt(end), ranges)) {
      end++
      if (end - pos >= SCAN_BAIL_AT) return undefined
    }
    return minOne && end === pos ? null : end
  }
}

/**
 * ASCII-case-fold a first-set: for every ASCII letter reachable as a leading char,
 * also admit its opposite-case twin (A–Z ↔ a–z). Non-letter code points and `any`/
 * `empty` are unchanged. Only widens the set (sound superset) — used to correct a
 * case-insensitive regex's flag-agnostic first-set for first-char dispatch. Unicode
 * case-folding beyond ASCII is deliberately NOT applied (parseman first-sets are
 * ASCII-BMP for dispatch); a non-ASCII letter keeps its own code point only, which
 * stays sound (the interpreter's real `/i` match still runs).
 */
function asciiCaseFold(fs: FirstSet): FirstSet {
  if (fs.kind !== 'ranges') return fs
  const ranges: { lo: number; hi: number }[] = fs.ranges.map(r => ({ lo: r.lo, hi: r.hi }))
  const add = (lo: number, hi: number): void => { if (lo <= hi) ranges.push({ lo, hi }) }
  for (const r of fs.ranges) {
    // Uppercase portion [A–Z] → lowercase twin (+32).
    const uLo = Math.max(r.lo, 65), uHi = Math.min(r.hi, 90)
    add(uLo + 32, uHi + 32)
    // Lowercase portion [a–z] → uppercase twin (−32).
    const lLo = Math.max(r.lo, 97), lHi = Math.min(r.hi, 122)
    add(lLo - 32, lHi - 32)
  }
  // Normalize: sort + coalesce overlapping/adjacent ranges.
  ranges.sort((a, b) => a.lo - b.lo)
  const merged: { lo: number; hi: number }[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.lo <= last.hi + 1) last.hi = Math.max(last.hi, r.hi)
    else merged.push({ lo: r.lo, hi: r.hi })
  }
  return { kind: 'ranges', ranges: merged }
}

export function regex(pattern: string | RegExp, flags = ''): Combinator<string> {
  const source = typeof pattern === 'string' ? pattern : pattern.source
  const resolvedFlags = typeof pattern === 'string' ? flags : pattern.flags

  const anchored = new RegExp(source, 'y' + resolvedFlags.replace(/[gy]/g, ''))
  const scan = shortScanner(source, resolvedFlags)

  const raw = (firstSetAnalyzer ?? permissiveFirstSet)(source)
  // The first-set analyzer is flag-agnostic, so for a CASE-INSENSITIVE pattern it
  // returns only the literal-case leading chars — e.g. `/red|blue/i` → `{r,b}`, NOT
  // `{r,R,b,B}`. Using that narrow set for first-char DISPATCH would false-EXCLUDE the
  // opposite-case input (`ReD` gated out of a `/(?:red|…)/i` arm). ASCII-case-fold the
  // leading set under `i` so it stays a correct SUPERSET (matches `keywords(ci)`).
  const firstSet = resolvedFlags.includes('i') ? asciiCaseFold(raw.firstSet) : raw.firstSet
  const canMatchNewline = raw.canMatchNewline
  const meta: ParserMeta = { firstSet, canMatchNewline, isTrivia: false }

  return {
    _tag: 'regex',
    _meta: meta,
    _def: { tag: 'regex', source, flags: resolvedFlags },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      const scanEnd = scan?.(input, pos)
      if (scanEnd !== undefined) {
        if (scanEnd === null) return failAt(ctx, [`/${source}/`], pos)
        const value = input.slice(pos, scanEnd)
        const span = { start: pos, end: scanEnd }
        if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value, span })
        return { ok: true, value, span }
      }
      anchored.lastIndex = pos
      const m = anchored.exec(input)
      if (m === null) {
        return failAt(ctx, [`/${source}/`], pos)
      }
      const span = { start: pos, end: pos + m[0]!.length }
      if (cstCaptureActive(ctx)) pushCstLeaf(ctx, { _tag: 'leaf', value: m[0]!, span })
      return { ok: true, value: m[0]!, span }
    },
  }
}
