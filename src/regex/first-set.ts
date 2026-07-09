/**
 * Hand-rolled first-set analysis for `regex()` terminals — the interpreter's
 * replacement for the old `regexp-tree`-backed analyzer (~264 KB). A `regex()`
 * terminal's first-set is used ONLY to let `choice()` do first-char dispatch
 * (see `choice.ts`); it is never consulted for whether a match succeeds. So this
 * analyzer only has to be SOUND as an OVER-approximation: every char the pattern
 * can actually start with must be in the returned set. Any construct it can't
 * pin down widens to `any()` (— "could start with anything" —), which only
 * disables a dispatch fast path, never changes a parse. Under-approximating
 * (dropping a real start char) WOULD be a bug: dispatch would skip a matching
 * arm. The differential fuzz test (`test/regex-first-set.test.ts`) checks this
 * against `regexp-tree` as an oracle.
 *
 * It parses the regex into a tiny AST (single-char matchers, sequence,
 * alternation, repetition, zero-width) reusing the shared char-class primitives
 * in `./classes.ts`, then walks the AST unioning first-sets through the nullable
 * prefix — the same shape the `regexp-tree` walker used.
 *
 * Note: flags are not consulted (matching the prior `regexp-tree` seam, which
 * parsed `/${source}/` with no flags), so an `/i` pattern's first-set is its
 * literal-case set. Sound for dispatch because the interpreter's `/i` regex arms
 * are compared case-sensitively at the same seam.
 */
import type { FirstSet } from '../types.ts'
import { any, empty, fromRange, union } from '../combinators/first-set.ts'
import { shorthandRanges, parseClassRanges } from './classes.ts'

// A minimal regex AST. Each node answers two questions: what first chars can a
// non-empty match begin with (`firstSet`), and can the node match zero chars
// (`nullable`). `any` is the over-approximation sentinel for anything we don't
// model precisely.
type Node =
  | { t: 'char'; set: FirstSet; nl: boolean } // matches exactly one char from `set`
  | { t: 'any' }                              // unknown 1-char-ish construct: could start with anything
  | { t: 'empty' }                            // zero-width: anchors, lookaround, word boundary
  | { t: 'seq'; parts: Node[] }
  | { t: 'alt'; arms: Node[] }
  | { t: 'rep'; node: Node; min: number }     // quantified; min 0 ⇒ nullable

const ANY: Node = { t: 'any' }
const EMPTY: Node = { t: 'empty' }

function charNode(set: FirstSet, nl: boolean): Node {
  return { t: 'char', set, nl }
}

function rangesToSet(ranges: Array<[number, number]>): FirstSet {
  let fs: FirstSet = empty()
  for (const [lo, hi] of ranges) fs = union(fs, fromRange(lo, hi))
  return fs
}

function rangesHaveNewline(ranges: Array<[number, number]>): boolean {
  return ranges.some(([lo, hi]) => lo <= 0x0a && 0x0a <= hi)
}

// ---------------------------------------------------------------------------
// Parser: recursive descent over a raw regex source (no surrounding delimiters).
// Throws `Bail` on a structure it can't parse (unbalanced group/class); the
// entry point catches it and degrades the WHOLE pattern to `any()`. A construct
// that parses but isn't modeled (a backreference, an exotic escape) becomes an
// `any` NODE instead — sound and more precise, since it only pollutes the
// first-set if reached in the nullable prefix.
// ---------------------------------------------------------------------------

/** Thrown on a structure the parser can't handle (unbalanced group/class); the
 * entry point catches it and degrades the whole pattern to `any()`. */
const BAIL = Symbol('regex-bail')

/**
 * Parse a raw regex `src` (no delimiters) into a `Node`, or throw `BAIL`.
 * Closure over a single cursor `i` — recursive-descent: alt → seq → quantified
 * → atom.
 */
function parseRegex(src: string): Node {
  let i = 0

  const parseAlt = (): Node => {
    const arms: Node[] = [parseSeq()]
    while (src[i] === '|') { i++; arms.push(parseSeq()) }
    return arms.length === 1 ? arms[0]! : { t: 'alt', arms }
  }

  const parseSeq = (): Node => {
    const parts: Node[] = []
    while (i < src.length) {
      const ch = src[i]!
      if (ch === '|' || ch === ')') break
      parts.push(parseQuantified())
    }
    if (parts.length === 0) return EMPTY
    return parts.length === 1 ? parts[0]! : { t: 'seq', parts }
  }

  const parseQuantified = (): Node => {
    const atom = parseAtom()
    const ch = src[i]
    let min: number | null = null
    if (ch === '*') { min = 0; i++ }
    else if (ch === '+') { min = 1; i++ }
    else if (ch === '?') { min = 0; i++ }
    else if (ch === '{') { min = parseBraceQuantifier() }
    if (min === null) return atom
    // Consume a lazy `?` on the quantifier — it changes greediness, not first-set.
    if (src[i] === '?') i++
    return { t: 'rep', node: atom, min }
  }

  // Parse `{n}` / `{n,}` / `{n,m}` at `i` (on `{`), returning the minimum; null
  // (leaving `{` unconsumed) if it isn't a well-formed brace quantifier, so the
  // caller keeps the `{` as the literal atom it already parsed.
  const parseBraceQuantifier = (): number | null => {
    const close = src.indexOf('}', i)
    if (close === -1) return null
    const m = /^(\d+)(?:,(\d*))?$/.exec(src.slice(i + 1, close))
    if (!m) return null
    i = close + 1
    return Number.parseInt(m[1]!, 10)
  }

  const parseAtom = (): Node => {
    const ch = src[i]!
    switch (ch) {
      case '(': return parseGroup()
      case '[': return parseClass()
      case '.': i++; return charNode(any(), false) // `.` matches any char except line terminators
      case '\\': return parseEscape()
      case '^':
      case '$': i++; return EMPTY // anchors are zero-width
      case '{': i++; return charNode(fromRange(0x7b, 0x7b), false) // a `{` with nothing to quantify is a literal brace
      default:
        i += ch.length
        return charNode(fromRange(ch.codePointAt(0)!, ch.codePointAt(0)!), ch === '\n')
    }
  }

  const parseGroup = (): Node => {
    i++ // consume '('
    // Group prefixes: (?:…) (?=…) (?!…) (?<=…) (?<!…) (?<name>…)
    let lookaround = false
    if (src[i] === '?') {
      const c1 = src[i + 1]
      if (c1 === ':') i += 2
      else if (c1 === '=' || c1 === '!') { i += 2; lookaround = true }
      else if (c1 === '<') {
        const c2 = src[i + 2]
        if (c2 === '=' || c2 === '!') { i += 3; lookaround = true } // lookbehind
        else { // named group (?<name>…): skip to '>'
          const gt = src.indexOf('>', i)
          if (gt === -1) throw BAIL
          i = gt + 1
        }
      } else throw BAIL // (? followed by something unexpected
    }
    const inner = parseAlt()
    if (src[i] !== ')') throw BAIL
    i++ // consume ')'
    return lookaround ? EMPTY : inner // lookaround is zero-width
  }

  const parseClass = (): Node => {
    // Read `[ ... ]`, honoring `\]`; detect leading `^` negation.
    let k = i + 1
    const negated = src[k] === '^'
    if (negated) k++
    let body = ''
    while (k < src.length && src[k] !== ']') {
      if (src[k] === '\\') { body += src[k]! + (src[k + 1] ?? ''); k += 2 }
      else { body += src[k]!; k++ }
    }
    if (src[k] !== ']') throw BAIL
    i = k + 1
    // A negated class can start with (almost) any char, and can match a newline
    // unless it excludes it (we don't try to prove exclusion — `true` is the safe
    // over-approximation).
    if (negated) return charNode(any(), true)
    const ranges = parseClassRanges(body)
    if (!ranges) return charNode(any(), true) // unparseable class → widen
    return charNode(rangesToSet(ranges), rangesHaveNewline(ranges))
  }

  const parseEscape = (): Node => {
    const e = src[i + 1]
    if (e === undefined) throw BAIL
    // \uXXXX
    if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
      const cp = Number.parseInt(src.slice(i + 2, i + 6), 16)
      i += 6
      return charNode(fromRange(cp, cp), cp === 0x0a)
    }
    // \xHH
    if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) {
      const cp = Number.parseInt(src.slice(i + 2, i + 4), 16)
      i += 4
      return charNode(fromRange(cp, cp), cp === 0x0a)
    }
    i += 2
    switch (e) {
      case 'd': return charNode(rangesToSet(shorthandRanges('d')), false)
      case 'w': return charNode(rangesToSet(shorthandRanges('w')), false)
      case 's': return charNode(rangesToSet(shorthandRanges('s')), true)
      case 'D': case 'W': case 'S': return charNode(any(), true) // negated shorthand → widen
      case 'b': case 'B': return EMPTY // word boundary: zero-width
      case 'n': return charNode(fromRange(0x0a, 0x0a), true)
      case 'r': return charNode(fromRange(0x0d, 0x0d), false)
      case 't': return charNode(fromRange(0x09, 0x09), false)
      case 'f': return charNode(fromRange(0x0c, 0x0c), false)
      case 'v': return charNode(fromRange(0x0b, 0x0b), false)
      case '0': return charNode(fromRange(0, 0), false)
      default:
        // A digit escape is a backreference we don't resolve → widen.
        if (e >= '1' && e <= '9') return ANY
        // Any other escape is a literal char (escaped metachar, `\/`, etc.).
        return charNode(fromRange(e.codePointAt(0)!, e.codePointAt(0)!), e === '\n')
    }
  }

  const node = parseAlt()
  if (i < src.length) throw BAIL // leftover (e.g. an unbalanced `)`)
  return node
}

// ---------------------------------------------------------------------------
// Walkers over the AST.
// ---------------------------------------------------------------------------

/** Can `n` succeed consuming zero characters? Err toward `true` when unsure —
 * over-estimating nullability only widens the (over-approximated) first-set. */
function nullable(n: Node): boolean {
  switch (n.t) {
    case 'char': return false
    case 'any': return true
    case 'empty': return true
    case 'seq': return n.parts.every(nullable)
    case 'alt': return n.arms.some(nullable)
    case 'rep': return n.min === 0 || nullable(n.node)
  }
}

/** First chars a non-empty match of `n` can begin with (over-approximated). */
function firstSet(n: Node): FirstSet {
  switch (n.t) {
    case 'char': return n.set
    case 'any': return any()
    case 'empty': return empty()
    case 'rep': return firstSet(n.node)
    case 'alt': {
      let fs: FirstSet = empty()
      for (const arm of n.arms) fs = union(fs, firstSet(arm))
      return fs
    }
    case 'seq': {
      // Union each part's first-set through the nullable prefix: a leading
      // nullable part lets a LATER part's first chars start the sequence.
      let fs: FirstSet = empty()
      for (const part of n.parts) {
        fs = union(fs, firstSet(part))
        if (!nullable(part)) break
      }
      return fs
    }
  }
}

/** Whether the first consumed char can be a newline (tracked separately from
 * `firstSet` because `.`/`\D`/negated classes widen to `any` yet differ on
 * whether that includes a newline). */
function firstCanBeNewline(n: Node): boolean {
  switch (n.t) {
    case 'char': return n.nl
    case 'any': return true
    case 'empty': return false
    case 'rep': return firstCanBeNewline(n.node)
    case 'alt': return n.arms.some(firstCanBeNewline)
    case 'seq': {
      for (const part of n.parts) {
        if (firstCanBeNewline(part)) return true
        if (!nullable(part)) break
      }
      return false
    }
  }
}

/**
 * Compute a regex terminal's first-set and newline-start flag from its SOURCE
 * (no delimiters, no flags). Over-approximates: an unparseable pattern degrades
 * to `{ any, canMatchNewline: true }` — the same conservative value the prior
 * `regexp-tree` seam returned on a parse failure.
 */
export function firstSetFromRegex(source: string): { firstSet: FirstSet; canMatchNewline: boolean } {
  let ast: Node
  try {
    ast = parseRegex(source)
  } catch {
    return { firstSet: any(), canMatchNewline: true }
  }
  // A NULLABLE pattern (can match zero chars) must widen to `any()`: as a
  // `choice()` arm it can succeed with an empty match at ANY position, so a
  // narrow first-set would let first-char dispatch wrongly skip it. Only a
  // pattern that must consume ≥1 char has a meaningful first-set.
  if (nullable(ast)) return { firstSet: any(), canMatchNewline: true }
  return { firstSet: firstSet(ast), canMatchNewline: firstCanBeNewline(ast) }
}
