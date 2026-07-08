import type { Combinator, ParseContext, ParseResult, ParserMeta, FirstSet } from '../types.ts'
import { any } from './first-set.ts'
import { failAt } from './probe.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'

/**
 * Computes a regex terminal's first-set (for choice-dispatch fast paths). The
 * only implementation — `firstSetFromRegex` in `./regex-analyze.ts` — is backed
 * by `regexp-tree` (~264 KB) and is registered by the interpreter/library entry
 * (`index.ts`) via `registerRegexAnalyzer`. It is injected rather than imported
 * so that consumers who ship only compiled grammars (or import `regex` directly
 * from this subpath) never pull `regexp-tree` into their bundle. When no
 * analyzer is registered, `regex()` uses the permissive `PERMISSIVE_FIRST_SET`
 * below — this only disables the dispatch fast paths, never changing matches.
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

const SPACE_RANGES: Array<[number, number]> = [
  [9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202],
  [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279],
]

const CLASS_ESCAPES: Record<string, number> = { t: 9, n: 10, r: 13, f: 12, v: 11, '0': 0 }

function shorthandRanges(ch: 'd' | 'w' | 's'): Array<[number, number]> {
  if (ch === 'd') return [[48, 57]]
  if (ch === 's') return SPACE_RANGES
  return [[48, 57], [65, 90], [97, 122], [95, 95]]
}

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (let i = 0; i < ranges.length; i++) {
    const [lo, hi] = ranges[i]!
    if (cp >= lo && cp <= hi) return true
  }
  return false
}

function readClassRanges(body: string): Array<[number, number]> | null {
  if (body.startsWith('^')) return null
  const ranges: Array<[number, number]> = []
  let i = 0
  const readAtom = (): { cp: number } | { ranges: Array<[number, number]> } | null => {
    const ch = body[i]
    if (ch === undefined) return null
    if (ch === '\\') {
      const esc = body[i + 1]
      if (esc === undefined) return null
      i += 2
      if (esc === 'd' || esc === 'w' || esc === 's') return { ranges: shorthandRanges(esc) }
      if (esc in CLASS_ESCAPES) return { cp: CLASS_ESCAPES[esc]! }
      if ((esc >= 'a' && esc <= 'z') || (esc >= 'A' && esc <= 'Z')) return null
      return { cp: esc.charCodeAt(0) }
    }
    i++
    return { cp: ch.charCodeAt(0) }
  }
  while (i < body.length) {
    const lo = readAtom()
    if (!lo) return null
    if ('ranges' in lo) {
      ranges.push(...lo.ranges)
      continue
    }
    if (body[i] === '-' && body[i + 1] !== undefined && body[i + 1] !== ']') {
      i++
      const hi = readAtom()
      if (!hi || 'ranges' in hi) return null
      ranges.push([lo.cp, hi.cp])
    } else {
      ranges.push([lo.cp, lo.cp])
    }
  }
  return ranges.length ? ranges : null
}

function shortScanner(source: string, flags: string): ShortScanner | null {
  if (/[imsuy]/.test(flags)) return null
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

export function regex(pattern: string | RegExp, flags = ''): Combinator<string> {
  const source = typeof pattern === 'string' ? pattern : pattern.source
  const resolvedFlags = typeof pattern === 'string' ? flags : pattern.flags

  const anchored = new RegExp(source, 'y' + resolvedFlags.replace(/[gy]/g, ''))
  const scan = shortScanner(source, resolvedFlags)

  const { firstSet, canMatchNewline } = (firstSetAnalyzer ?? permissiveFirstSet)(source)
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
        const leaf = { _tag: 'leaf', value, span }
        if (cstCaptureActive(ctx)) pushCstLeaf(ctx, leaf)
        return { ok: true, value, span }
      }
      anchored.lastIndex = pos
      const m = anchored.exec(input)
      if (m === null) {
        return failAt(ctx, [`/${source}/`], pos)
      }
      const span = { start: pos, end: pos + m[0]!.length }
      const leaf = { _tag: 'leaf', value: m[0]!, span }
      if (cstCaptureActive(ctx)) pushCstLeaf(ctx, leaf)
      return { ok: true, value: m[0]!, span }
    },
  }
}
