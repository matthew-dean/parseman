/**
 * THE LABELLED-TRIVIA SCANNER, AT CHARACTER LEVEL.
 *
 * `fastTriviaScanner` (`../combinators/trivia-skip.ts`) already lowers UNLABELLED
 * trivia to a char loop. Labelled trivia had no equivalent, so every gap between
 * two sequence terms in a `classifiedTrivia()` grammar ran the arms as actual
 * COMBINATORS — `matchArmAt` → `startsFirstSet` → a detached `ParseContext` → the
 * regex combinator's `ParseResult`. On `benchmark.less`, one parse takes that path
 * 31,758 times, tries 113,091 arms, and enters 13,696 of them, to classify 11,963
 * chunks covering 33,981 characters — about 2.8 characters per chunk, for which the
 * combinator machinery is pure overhead.
 *
 * The arms are static grammar data (`encode.ts`'s `triviaSpecOf` already lowers
 * them to `[label, source, flags]`), so they can be classified ONCE, per spec, into
 * per-arm character matchers. Anything that does not classify yields `null` and the
 * combinator path stands — there is no fast path that is only usually right.
 *
 * A matcher returns the END of its match, or `pos` for "no match". That is exactly
 * `matchArmAt`'s contract (`!r.ok || r.span.end <= pos` → null), so a lowered arm
 * and a combinator arm are interchangeable inside the scan loops.
 *
 * The parser `state` `matchArmAt` threads into its detached context is not carried
 * here, and does not need to be: only a plain `regex` arm lowers, and a regex
 * terminal never reads state. An arm that could is exactly an arm that fails to
 * classify.
 */
import type { Combinator } from '../types.ts'
import { parseClassRanges } from '../regex/classes.ts'
import { commonCssTriviaVisitor, type CssTriviaVisitor } from './trivia-css-scanner.ts'
import type { LabeledTriviaSpec } from './trivia-kinds.ts'

export type TriviaArmMatcher = (input: string, pos: number) => number

type Ranges = Array<[number, number]>

function inRanges(cp: number, ranges: Ranges): boolean {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!
    if (cp >= r[0] && cp <= r[1]) return true
  }
  return false
}

/**
 * A run of LITERAL characters as code points, or null.
 *
 * Only punctuation may be backslash-escaped: `\n`/`\d`/`\w` are not literals, and
 * decoding them as one would silently accept a different language.
 */
function literalCodes(src: string): number[] | null {
  const codes: number[] = []
  for (let i = 0; i < src.length; i++) {
    let c = src[i]!
    if (c === '\\') {
      c = src[i + 1] ?? ''
      if (c === '' || /[A-Za-z0-9]/.test(c)) return null
      i++
    } else if (/[[\]()|*+?{}^$.]/.test(c)) {
      return null
    }
    codes.push(c.charCodeAt(0))
  }
  return codes.length > 0 ? codes : null
}

/**
 * ONE character as it appears inside a character class, where `*` and friends are
 * ordinary characters. `\x`-style escapes still have to be punctuation.
 */
function classLiteralCode(src: string): number | null {
  if (src.length === 1) return src.charCodeAt(0)
  if (src.length === 2 && src[0] === '\\' && !/[A-Za-z0-9]/.test(src[1]!)) return src.charCodeAt(1)
  return null
}

/** `[cls]+` / `[cls]*` — a positive character-class run. */
function classifyClassRun(src: string): TriviaArmMatcher | null {
  const m = /^\[([^\]^](?:[^\]]|\\.)*)\][*+]$/.exec(src)
  if (!m) return null
  const ranges = parseClassRanges(m[1]!)
  if (!ranges) return null
  // `*` can match empty, but an empty match is "no match" to every caller here
  // (`matchArmAt` rejects `end <= pos`), so both quantifiers scan the same.
  return (input, pos) => {
    let p = pos
    while (p < input.length && inRanges(input.charCodeAt(p), ranges)) p++
    return p
  }
}

/** `//[^\n\r]*` — a literal leader run to (not including) the line break. */
function classifyLineRun(src: string): TriviaArmMatcher | null {
  const m = /^(.*?)\[\^(?:\\n\\r|\\r\\n)\]\*$/.exec(src)
  if (!m) return null
  const codes = literalCodes(m[1]!)
  if (!codes) return null
  const n = codes.length
  return (input, pos) => {
    for (let i = 0; i < n; i++) if (input.charCodeAt(pos + i) !== codes[i]) return pos
    let p = pos + n
    while (p < input.length) {
      const c = input.charCodeAt(p)
      if (c === 10 || c === 13) break
      p++
    }
    return p
  }
}

/**
 * `/*(?:[^*]|\*(?!\/))*\*\/` — a literal-delimited run, i.e. a block comment.
 *
 * The body alternation can never consume the closing pair, so the greedy regex
 * stops at the FIRST close: an `indexOf` is not an approximation of it, it is the
 * same position. An unterminated open fails in both, since the close is required.
 */
function classifyDelimited(src: string): TriviaArmMatcher | null {
  const m = /^(\\?.)(\\?.)\(\?:\[\^(\\?.)\]\|(\\?.)\(\?!(\\?.)\)\)\*(\\?.)(\\?.)$/.exec(src)
  if (!m) return null
  const open = literalCodes(m[1]! + m[2]!)
  const close = literalCodes(m[6]! + m[7]!)
  // `m[3]` sits inside `[^…]`, where a regex metacharacter stands for itself and
  // needs no backslash — so it is read with the class-body rule, not the strict one.
  const bodyExcluded = classLiteralCode(m[3]!)
  const bodyGuard = literalCodes(m[4]!)
  const guardNext = literalCodes(m[5]!)
  if (!open || !close || bodyExcluded === null || !bodyGuard || !guardNext) return null
  // The body must exclude exactly the close pair and nothing else — the shape
  // `(?:[^C0]|C0(?!C1))*` with `C0C1` the close.
  if (bodyExcluded !== close[0] || bodyGuard[0] !== close[0] || guardNext[0] !== close[1]) return null
  const closeStr = String.fromCharCode(...close)
  const openLen = open.length
  const closeLen = closeStr.length
  return (input, pos) => {
    for (let i = 0; i < openLen; i++) if (input.charCodeAt(pos + i) !== open[i]) return pos
    const hit = input.indexOf(closeStr, pos + openLen)
    return hit < 0 ? pos : hit + closeLen
  }
}

/** Split a regex body on top-level `|`, tracking group depth and classes. */
function splitAlts(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let inClass = false
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\') { i++; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') inClass = true
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '|' && depth === 0) { out.push(body.slice(start, i)); start = i + 1 }
  }
  out.push(body.slice(start))
  return out
}

/** Strip one full-span `(?:…)` wrapper. */
function unwrapGroup(src: string): string {
  if (!src.startsWith('(?:') || !src.endsWith(')')) return src
  let depth = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return i === src.length - 1 ? src.slice(3, -1) : src }
  }
  return src
}

/**
 * `(?:A|B|C)+` — one arm that is itself a whole trivia alternation (the shape
 * `classifiedTrivia({ whitespace: /…|…|…/ })` produces when a grammar gives every
 * form the SAME label).
 *
 * ORDERED-GREEDY IS THE REGEX RESULT, not an approximation of it. A greedy `+`
 * only reconsiders an alternative when the CONTINUATION fails, and here the
 * continuation is "more repetitions, then end of pattern", which cannot fail once
 * one repetition has matched. So the engine keeps the first alternative that
 * matches at each position, exactly as this loop does — no disjointness needed
 * (`//` and `/*` share a leading `/` and still agree). An alternative that matches
 * empty terminates both, as `end > p` requires progress.
 */
function classifyAltRun(src: string): TriviaArmMatcher | null {
  const m = /^\((?:\?:)?(.*)\)[*+]$/.exec(src)
  if (!m) return null
  const parts = splitAlts(m[1]!)
  if (parts.length < 2) return null
  const matchers: TriviaArmMatcher[] = []
  for (const part of parts) {
    const sub = classifyArm(unwrapGroup(part))
    if (!sub) return null
    matchers.push(sub)
  }
  const n = matchers.length
  return (input, pos) => {
    let p = pos
    scan: while (p < input.length) {
      for (let i = 0; i < n; i++) {
        const end = matchers[i]!(input, p)
        if (end > p) { p = end; continue scan }
      }
      break
    }
    return p
  }
}

function classifyArm(src: string): TriviaArmMatcher | null {
  return classifyClassRun(src)
    ?? classifyLineRun(src)
    ?? classifyDelimited(src)
    ?? classifyAltRun(src)
}

function classifyParser(p: Combinator<unknown>): TriviaArmMatcher | null {
  const d = p._def
  if (d.tag !== 'regex' || d.flags) return null
  return classifyArm(d.source)
}

function plainRegexSource(p: Combinator<unknown>): string | null {
  const d = p._def
  return d.tag === 'regex' && d.flags === '' ? d.source : null
}

let visitSpec0: LabeledTriviaSpec | undefined
let visitSpec1: LabeledTriviaSpec | undefined
let visitSpec2: LabeledTriviaSpec | undefined
let visitSpec3: LabeledTriviaSpec | undefined
let visitValue0: CssTriviaVisitor | null | undefined
let visitValue1: CssTriviaVisitor | null | undefined
let visitValue2: CssTriviaVisitor | null | undefined
let visitValue3: CssTriviaVisitor | null | undefined

/** A direct classified scanner for the four canonical CSS/Less trivia tuples. */
export function commonLabeledTriviaVisitor(spec: LabeledTriviaSpec): CssTriviaVisitor | null {
  if (spec === visitSpec0) return visitValue0!
  if (spec === visitSpec1) return visitValue1!
  if (spec === visitSpec2) return visitValue2!
  if (spec === visitSpec3) return visitValue3!
  const sources = spec.minRepeats <= 1 ? spec.arms.map(arm => plainRegexSource(arm.parser)) : []
  const visitor = commonCssTriviaVisitor(sources)
  visitSpec3 = visitSpec2
  visitValue3 = visitValue2
  visitSpec2 = visitSpec1
  visitValue2 = visitValue1
  visitSpec1 = visitSpec0
  visitValue1 = visitValue0
  visitSpec0 = spec
  visitValue0 = visitor
  return visitor
}

let armSpec0: LabeledTriviaSpec | undefined
let armSpec1: LabeledTriviaSpec | undefined
let armSpec2: LabeledTriviaSpec | undefined
let armSpec3: LabeledTriviaSpec | undefined
let armValue0: readonly TriviaArmMatcher[] | null | undefined
let armValue1: readonly TriviaArmMatcher[] | null | undefined
let armValue2: readonly TriviaArmMatcher[] | null | undefined
let armValue3: readonly TriviaArmMatcher[] | null | undefined

/**
 * The character-level matchers for a spec's arms — index-parallel to `spec.arms`,
 * so a matcher's index IS its kind index — or `null` when any arm has no lowering.
 *
 * `spec.minRepeats > 1` is excluded: the loops below report only an END, and a run
 * that fails a minimum of two must report NOTHING. `classifiedTrivia()` never
 * produces one, and the combinator path still handles it if a host writes one.
 */
export function charArmsFor(spec: LabeledTriviaSpec): readonly TriviaArmMatcher[] | null {
  if (spec === armSpec0) return armValue0!
  if (spec === armSpec1) return armValue1!
  if (spec === armSpec2) return armValue2!
  if (spec === armSpec3) return armValue3!
  let arms: TriviaArmMatcher[] | null = []
  if (spec.minRepeats > 1) {
    arms = null
  } else {
    for (const arm of spec.arms) {
      const c = classifyParser(arm.parser)
      if (!c) { arms = null; break }
      arms.push(c)
    }
  }
  armSpec3 = armSpec2
  armValue3 = armValue2
  armSpec2 = armSpec1
  armValue2 = armValue1
  armSpec1 = armSpec0
  armValue1 = armValue0
  armSpec0 = spec
  armValue0 = arms
  return arms
}

/** End of the trivia run at `cur`, or `cur` when nothing matched. */
export function charTriviaEnd(input: string, cur: number, arms: readonly TriviaArmMatcher[]): number {
  const n = arms.length
  let pos = cur
  scan: while (pos < input.length) {
    for (let i = 0; i < n; i++) {
      const end = arms[i]!(input, pos)
      if (end > pos) { pos = end; continue scan }
    }
    break
  }
  return pos
}

/** As `charTriviaEnd`, reporting each chunk with the kind index that matched it. */
export function charTriviaVisit(
  input: string,
  cur: number,
  arms: readonly TriviaArmMatcher[],
  visit: (start: number, end: number, kindIndex: number) => void,
): number {
  const n = arms.length
  let pos = cur
  scan: while (pos < input.length) {
    for (let i = 0; i < n; i++) {
      const end = arms[i]!(input, pos)
      if (end > pos) { visit(pos, end, i); pos = end; continue scan }
    }
    break
  }
  return pos
}

/** The `1 << kindIndex` mask of the categories in the run at `cur`. */
export function charTriviaKindMask(input: string, cur: number, arms: readonly TriviaArmMatcher[]): number {
  const n = arms.length
  let pos = cur
  let mask = 0
  scan: while (pos < input.length) {
    for (let i = 0; i < n; i++) {
      const end = arms[i]!(input, pos)
      if (end > pos) { mask |= 1 << i; pos = end; continue scan }
    }
    break
  }
  return mask
}
