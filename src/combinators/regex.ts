import type { Combinator, ParseContext, ParseResult, ParserMeta, FirstSet } from '../types.ts'
import { any } from './first-set.ts'
import { shorthandRanges, parseClassRanges } from '../regex/classes.ts'
import { firstSetFromRegex } from '../regex/first-set.ts'
import { directTerminalFailureExpected } from './expected.ts'
import { scalarResult, type ScalarParser } from './scalar.ts'

/**
 * A regex terminal's first-set (for choice-dispatch fast paths) is derived by
 * `firstSetFromRegex` in `../regex/first-set.ts` — a small, dependency-free
 * hand-rolled regex parser, imported DIRECTLY and unconditionally.
 *
 * ── WHY NOT INJECTED ────────────────────────────────────────────────────────────
 * It used to be registered at run time by the library entry (`index.ts`) via a
 * `registerRegexAnalyzer` seam, so that a bundle holding `regex()` without the
 * library entry never pulled the analyzer in. That saved ~3 KB and cost a shipped
 * export: `parseman/table` is its OWN module graph, so its private copy of this
 * module never saw the registration, `regex()` there returned the permissive
 * `any()` first-set, and `classifiedTrivia()` — which REQUIRES a concrete finite
 * first set per arm — rejected every arm of every table-lowered grammar
 * (`buildTrivia` in `../table/program.ts`). The failure was invisible from source,
 * where `src/index.ts` is always in the graph.
 *
 * A mutable module-global that a *different* entry has to remember to write makes
 * `regex()`'s result depend on which bundle it landed in. Deriving the first set
 * intrinsically makes every module graph agree by construction. The analyzer adds
 * no new leaf modules — it imports only `./first-set.ts` and `../regex/classes.ts`,
 * both already reachable from here — so the cost is the analyzer's own bytes.
 */
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

  const raw = firstSetFromRegex(source)
  // The first-set analyzer is flag-agnostic, so for a CASE-INSENSITIVE pattern it
  // returns only the literal-case leading chars — e.g. `/red|blue/i` → `{r,b}`, NOT
  // `{r,R,b,B}`. Using that narrow set for first-char DISPATCH would false-EXCLUDE the
  // opposite-case input (`ReD` gated out of a `/(?:red|…)/i` arm), so widen it under
  // `i`. The widening is FLAG-AWARE because `i` alone and `i`+`u` fold different sets:
  //   - `/i` WITHOUT `u`: ECMAScript case-insensitive matching folds ONLY the ASCII
  //     Basic-Latin case pairs (`a`↔`A` … `z`↔`Z`) — a plain `/[a-z]/i` does NOT match
  //     `ſ`(U+017F) or `K`(U+212A). So `asciiCaseFold` is a SOUND, tight superset, and
  //     it preserves at-keyword dispatch (`/@media…/i` still gates on `@`).
  //   - `/ui` or `/iv` (Unicode mode — the `u` OR the ES2024 `v` Unicode-sets flag):
  //     matching uses Unicode *simple case folding*, so `/[a-z]/ui` (and `/[a-z]/iv`)
  //     ALSO match `ſ`→s and `K`→k. ASCII-folding can't enumerate those astral/BMP case
  //     pairs, so gating on the ASCII set would false-exclude them. Fall back to `any()`
  //     (always-try) — sound, and only forfeits gating for the rare Unicode-mode `/i`
  //     recognizer, never the ASCII-only `/i` at-keywords the fix targets.
  const firstSet = !resolvedFlags.includes('i')
    ? raw.firstSet
    : (resolvedFlags.includes('u') || resolvedFlags.includes('v'))
      ? any()
      : asciiCaseFold(raw.firstSet)
  const meta: ParserMeta = { firstSet, canMatchNewline: raw.canMatchNewline, isTrivia: false }
  const def = { tag: 'regex', source, flags: resolvedFlags } as const
  const expected = directTerminalFailureExpected(def)
  const parseScalar: ScalarParser = (input, pos, ctx) => {
    const scanEnd = scan?.(input, pos)
    if (scanEnd !== undefined) {
      if (scanEnd === null) {
        ctx._fx = expected
        return ~pos
      }
      ctx._sv = input.slice(pos, scanEnd)
      return scanEnd
    }
    anchored.lastIndex = pos
    const m = anchored.exec(input)
    if (m === null) {
      ctx._fx = expected
      return ~pos
    }
    ctx._sv = m[0]!
    return pos + m[0]!.length
  }

  return {
    _tag: 'regex',
    _meta: meta,
    _def: def,
    _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      return scalarResult(parseScalar(input, pos, ctx), pos, ctx)
    },
  }
}
