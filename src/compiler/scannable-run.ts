/**
 * Structural recognition of "scannable" parser arms — regex shapes that lower to
 * a tight character-scan loop instead of `regex.exec` / combinator dispatch. Each
 * shape is derived from the regex STRUCTURE, not from any hardcoded knowledge
 * that a given regex "is whitespace" or "is a comment":
 *
 *   [X]+ / [X]*            → run while the char ∈ X                (chars)
 *   <lit>[^X]*             → consume <lit>, run until char ∈ X     (until)
 *   <open>(?:…)*<close>    → consume <open>, run to <close> literal (delimited)
 *   x?<lit><[X]*>…         → a general linear chain of lit/run     (seq)
 *
 * `seq` is the CATEGORY generalization: any chain of literal segments (required
 * or optional `x?`) and char-class runs (positive/negated, `?`/`*`/`+`). It
 * subsumes CSS/Less `-?ident`, `--custom`, `@-?keyword`, `[^…]+`, `::?`, etc.
 * without hardcoding a single byte — lowered only when a greedy one-pass scan
 * provably equals the engine's backtracking (see `seqIsUnambiguous`).
 *
 * A `oneOrMore(choice(a, b, …))` where every arm is one of these compiles to a
 * single char-dispatch loop with one branch per arm — any count/order, because
 * the shapes dispatch on their first 1–2 chars and are checked in turn. Trivia
 * (whitespace + comments) is just the value-discarded instance of this; nothing
 * here is trivia-specific.
 */

/**
 * One segment of a `seq` shape. A `seq` is the general category "a fixed linear
 * chain of literals and char-class runs" — no alternation, no groups, no
 * backtracking. It subsumes every CSS/Less token that is "(optional prefix)?
 * literal* char-run* …" without hardcoding any particular byte:
 *
 *   lit   — a run of fixed code points, optionally present (`x?`) or required.
 *   run   — a char-class run: positive/negated ranges, min 0/1, bounded to one
 *           char (`[x]`, `[x]?`) or unbounded (`[x]*`, `[x]+`).
 *   group — a non-capturing sub-pattern `(?:…)` (§8f), quantified the same way
 *           as `run` (`min`/`unbounded`). `inner` is any already-recognized
 *           `ScanShape` for the group's body (so a group can itself contain
 *           `seq`/`chars`/`alt`/… — including a nested alternation via §8e).
 *           Only used when `groupInnerSafe(inner)` holds (see that function).
 *
 * We only lower a `seq` when greedy left-to-right scanning provably equals the
 * regex engine's backtracking match (see `seqIsUnambiguous`).
 */
export type SeqPart =
  | { part: 'lit'; cps: number[]; optional: boolean }
  // `escapes`: each position is a class char OR a CSS escape (`\` + 1–6 hex +
  // optional ws, or `\` + one non-newline char) — the css/less/scss/jess
  // `ident`/`basicSel`/`propName` shape. `negated` is always false when escapes.
  | { part: 'run'; ranges: Array<[number, number]>; negated: boolean; min: 0 | 1; unbounded: boolean; escapes?: boolean }
  | { part: 'group'; inner: ScanShape; min: 0 | 1; unbounded: boolean }

export type ScanShape =
  | { kind: 'chars'; ranges: Array<[number, number]>; minOne: boolean }
  | { kind: 'ident'; head: Array<[number, number]>; tail: Array<[number, number]> }
  | { kind: 'until'; open: number[]; stop: Array<[number, number]> }
  | { kind: 'delimited'; open: number[]; close: number[] }
  // <q>(?:[^<q>\\]|\\.)*<q> — a quote-delimited string with backslash escapes.
  // `excluded` = the body's negated class (always contains the quote + backslash,
  // maybe a newline); `escLineTerm` = whether `\\` may be followed by a line
  // terminator (`\\[\s\S]` → true, `\\.` → false, since `.` excludes them).
  | { kind: 'string'; quote: number; excluded: Array<[number, number]>; escLineTerm: boolean }
  // A linear chain of literal/char-run segments (optional prefixes, literal
  // openers, negated runs, …) — the general CSS/Less token category.
  | { kind: 'seq'; parts: SeqPart[] }
  // A pure literal matched case-insensitively (`/i`): the general "ASCII
  // case-fold literal" category (CSS `url(`, `@media` keywords under `i`, …).
  | { kind: 'litFold'; open: number[] }
  // `<inner>(?!class)` / `<inner>(?=class)` — a trailing lookahead boundary
  // check on an already-lowered shape. Zero-width: `end` is `inner`'s end, never
  // extended. `classNegated` is the bracket's OWN `[^…]` negation (e.g.
  // `(?![0-9a-fA-F])` vs `(?=[^0-9])`), independent of `negative` (`!` vs `=`).
  | { kind: 'lookahead'; inner: ScanShape; ranges: Array<[number, number]>; classNegated: boolean; negative: boolean }
  // `A|B|C` — top-level alternation (§8e), split outside any `[]`/`()`, each arm
  // independently lowered. `disjoint` is true iff every pair of arms has
  // provably non-overlapping first-char sets (`firsts[i]` holds that arm's set,
  // or `null` if it could start with any char — an unbounded-optional `chars`
  // arm, or a non-disjoint mix). When `disjoint`, codegen dispatches straight to
  // the one matching arm; otherwise it tries arms in order and takes the first
  // that succeeds — the same ordered-choice semantics as regex `|` itself (see
  // the ordered-vs-longest verification in PERF_IDEAS §8e).
  | { kind: 'alt'; arms: ScanShape[]; disjoint: boolean; firsts: Array<CharSet | null> }

/** Backslash (`\`) code point — the escape lead char in string shapes. */
export const BACKSLASH = 92

const CLASS_ESCAPES: Record<string, number> = { t: 9, n: 10, r: 13, f: 12, v: 11, '0': 0 }
const META = new Set('()[]{}*+?|^$.'.split(''))

/**
 * `\s`'s code-point set per the spec's `WhiteSpace` + `LineTerminator`
 * productions — TAB/LF/VT/FF/CR, SPACE, NBSP, and the Unicode `Zs` space
 * separators. This set is fixed regardless of the `u` flag (unlike `\d`/`\w`,
 * which are ASCII-only without `u` but widen with it), so it's always safe to
 * lower to a fixed range scan.
 */
export const SPACE_RANGES: Array<[number, number]> = [
  [9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202],
  [8232, 8232], [8233, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279],
]

/**
 * ASCII code-point ranges for the shorthand classes we can lower safely. `\d`
 * and `\w` are ASCII-only in the default (non-`u`) engine, so they map to fixed
 * ranges. `\s` maps to `SPACE_RANGES` — a fixed set unaffected by the `u` flag.
 */
function shorthandRanges(ch: 'd' | 'w' | 's'): Array<[number, number]> {
  if (ch === 'd') return [[48, 57]]
  if (ch === 's') return SPACE_RANGES
  return [[48, 57], [65, 90], [97, 122], [95, 95]]
}

type ClassAtom = { cp: number } | { set: Array<[number, number]> }

/**
 * Parse a regex char-class body (chars between `[` and `]`) to code-point ranges.
 * `\d`/`\w` expand to their ASCII ranges; other letter escapes (`\s`, `\D`,
 * `\W`, `\S`, `\b`, …) return null rather than being mis-read as literal letters.
 */
function readUnicodeEscape(body: string, i: number): { cp: number; next: number } | null {
  if (body[i] !== '\\' || body[i + 1] !== 'u') return null
  const hex = body.slice(i + 2, i + 6)
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
  return { cp: Number.parseInt(hex, 16), next: i + 6 }
}

export function parseClassRanges(body: string): Array<[number, number]> | null {
  const ranges: Array<[number, number]> = []
  let i = 0
  const readAtom = (): ClassAtom | null => {
    const ch = body[i]
    if (ch === undefined) return null
    if (ch === '\\') {
      const uni = readUnicodeEscape(body, i)
      if (uni) {
        i = uni.next
        return { cp: uni.cp }
      }
      const e = body[i + 1]
      if (e === undefined) return null
      i += 2
      if (e in CLASS_ESCAPES) return { cp: CLASS_ESCAPES[e]! }
      if (e === 'd' || e === 'w' || e === 's') return { set: shorthandRanges(e) }
      // Any other letter escape is a class we can't safely lower (\D, \W, \S, …).
      if ((e >= 'a' && e <= 'z') || (e >= 'A' && e <= 'Z')) return null
      return { cp: e.codePointAt(0)! }
    }
    i += ch.length
    return { cp: ch.codePointAt(0)! }
  }
  while (i < body.length) {
    const lo = readAtom()
    if (lo === null) return null
    if ('set' in lo) {
      ranges.push(...lo.set)
      continue
    }
    if (body[i] === '-' && body[i + 1] !== undefined && body[i + 1] !== ']') {
      i += 1
      const hi = readAtom()
      if (hi === null || 'set' in hi) return null
      ranges.push([lo.cp, hi.cp])
    } else {
      ranges.push([lo.cp, lo.cp])
    }
  }
  return ranges.length ? ranges : null
}

/** A single class token (`[...]` or `\d`/`\w`) to ranges, or null. Rejects negation. */
function classToRanges(cls: string): Array<[number, number]> | null {
  if (cls === '\\d') return shorthandRanges('d')
  if (cls === '\\w') return shorthandRanges('w')
  if (cls === '\\s') return shorthandRanges('s')
  const body = cls.slice(1, -1)
  if (body.startsWith('^')) return null
  return parseClassRanges(body)
}

/** ASCII case-insensitive letter check for `i`-flag literal lowering. */
// ASCII case-insensitive char compare. For a letter, upper/lower differ only in
// bit 0x20, and `(c | 32) === <lowercase>` is satisfied by EXACTLY that letter's
// two cases (nothing else) — one OR + one compare, ~1.75× faster than the
// two-compare `(c===U || c===L)` form (measured). `(… | 32)` is parenthesized
// because `===` binds tighter than `|`. Non-letters keep an exact compare.
const foldEq = (cVar: string, cp: number): string => {
  if (cp >= 65 && cp <= 90) return `(${cVar} | 32) === ${cp + 32}`
  if (cp >= 97 && cp <= 122) return `(${cVar} | 32) === ${cp}`
  return `${cVar} === ${cp}`
}

/** All-literal regex fragment (`\/\*`, `\/\/`, …) → its code points, or null on an unescaped metachar. */
function literalCodePoints(frag: string): number[] | null {
  const out: number[] = []
  let i = 0
  while (i < frag.length) {
    const ch = frag[i]!
    if (ch === '\\') {
      const e = frag[i + 1]
      if (e === undefined) return null
      out.push(e in CLASS_ESCAPES ? CLASS_ESCAPES[e]! : e.codePointAt(0)!)
      i += 2
      continue
    }
    if (META.has(ch)) return null
    out.push(ch.codePointAt(0)!)
    i += 1
  }
  return out.length ? out : null
}

/**
 * Recognize a quote-delimited string with backslash escapes:
 *   <q>(?:[^…]|\\.)*<q>  or  <q>(?:\\.|[^…])*<q>   (`?:` optional)
 * where the negated body class contains the quote and the backslash, and the
 * escape body is `.` (no line terminators) or `[\s\S]` (any char). Returns null
 * for anything else so the caller falls back to `regex.exec`.
 */
function parseStringShape(source: string): ScanShape | null {
  const q = source[0]
  if (q === undefined || q === '\\' || META.has(q)) return null
  if (source.length < 3 || source[source.length - 1] !== q) return null
  const inner = source.slice(1, -1)
  const CLS = String.raw`\[\^((?:\\.|[^\]])+)\]`
  const ESC = String.raw`\\\\(\.|\[\\s\\S\]|\[\\S\\s\])`
  // Two arm orders; `?:` optional. Capture groups differ, so read both out.
  let body: string | undefined
  let esc: string | undefined
  let m = new RegExp(`^\\((?:\\?:)?${CLS}\\|${ESC}\\)\\*$`).exec(inner)
  if (m) { body = m[1]; esc = m[2] }
  else {
    m = new RegExp(`^\\((?:\\?:)?${ESC}\\|${CLS}\\)\\*$`).exec(inner)
    if (m) { esc = m[1]; body = m[2] }
  }
  if (body === undefined || esc === undefined) return null
  const excluded = parseClassRanges(body)
  if (!excluded) return null
  const qcp = q.codePointAt(0)!
  const inSet = (cp: number) => excluded.some(([lo, hi]) => cp >= lo && cp <= hi)
  if (!inSet(qcp) || !inSet(BACKSLASH)) return null
  return { kind: 'string', quote: qcp, excluded, escLineTerm: esc !== '.' }
}

/**
 * Parse a regex source into a linear chain of literal / char-run segments, or
 * null if it uses any construct outside that category (alternation, groups,
 * `.`, `{n,m}`, lookaround, unknown escapes). This is the STRUCTURAL recognizer
 * for the `seq` shape — it encodes categories (optional prefix, literal opener,
 * negated run, …), never any specific byte value.
 */
// The CSS escape as it appears in the ident/selector/prop-name regexes —
// computed from the SAME literal so a match is exact, never drifts. A run whose
// every position is `[class] | <this escape>` lowers to an escape-aware scan.
const CSS_ESCAPE_SRC = /\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n])/.source

/**
 * Recognize a `(?:…)` group body of the form `[class]|\\(?:[0-9a-fA-F]{1,6}[ …]?|[^\n])`
 * (one CSS ident position: a class char OR a CSS escape). Returns the class
 * ranges, or null. The escape tail is matched against `CSS_ESCAPE_SRC` verbatim.
 */
function matchCssEscapeClassAlt(body: string): Array<[number, number]> | null {
  const tail = '|' + CSS_ESCAPE_SRC
  if (!body.endsWith(tail)) return null
  const classPart = body.slice(0, body.length - tail.length)
  if (classPart.length < 2 || classPart[0] !== '[' || classPart[classPart.length - 1] !== ']') return null
  const inner = classPart.slice(1, -1)
  if (inner.startsWith('^')) return null
  return parseClassRanges(inner)
}

function parseSeqParts(source: string): SeqPart[] | null {
  const parts: SeqPart[] = []
  let lit: number[] = []
  const flush = () => {
    if (lit.length) { parts.push({ part: 'lit', cps: lit, optional: false }); lit = [] }
  }
  const runFrom = (ranges: Array<[number, number]>, negated: boolean, q: string | undefined) => {
    if (q === '+') { parts.push({ part: 'run', ranges, negated, min: 1, unbounded: true }); return 1 }
    if (q === '*') { parts.push({ part: 'run', ranges, negated, min: 0, unbounded: true }); return 1 }
    if (q === '?') { parts.push({ part: 'run', ranges, negated, min: 0, unbounded: false }); return 1 }
    parts.push({ part: 'run', ranges, negated, min: 1, unbounded: false })
    return 0
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '[') {
      // Read a char class, honoring `\]`.
      let k = i + 1
      const neg = source[k] === '^'
      if (neg) k++
      let body = ''
      while (k < source.length && source[k] !== ']') {
        if (source[k] === '\\') { body += source[k]! + (source[k + 1] ?? ''); k += 2 }
        else { body += source[k]!; k++ }
      }
      if (source[k] !== ']') return null
      const ranges = parseClassRanges(body)
      if (!ranges) return null
      flush()
      i = k + 1
      i += runFrom(ranges, neg, source[i])
      continue
    }
    if (ch === '\\') {
      const e = source[i + 1]
      if (e === 'd' || e === 'w' || e === 's') {
        flush()
        i += 2
        i += runFrom(shorthandRanges(e), false, source[i])
        continue
      }
      // Escaped literal code point (incl. `\uXXXX`, `\t`, `\(`, …).
      const uni = readUnicodeEscape(source, i)
      let cp: number
      if (uni) { cp = uni.cp; i = uni.next }
      else if (e === undefined) return null
      else if (e in CLASS_ESCAPES) { cp = CLASS_ESCAPES[e]!; i += 2 }
      else if ((e >= 'a' && e <= 'z') || (e >= 'A' && e <= 'Z')) return null
      else { cp = e.codePointAt(0)!; i += 2 }
      if (source[i] === '?') { flush(); parts.push({ part: 'lit', cps: [cp], optional: true }); i++ }
      else lit.push(cp)
      continue
    }
    if (ch === '(') {
      // Only a non-capturing group `(?:…)` is modeled (§8f) — a bare capturing
      // group, or a lookaround appearing mid-pattern (a TRAILING one is peeled
      // off separately by `stripTrailingLookahead` before we ever get here), is
      // declined outright rather than risk misreading it.
      if (source[i + 1] !== '?' || source[i + 2] !== ':') return null
      let k = i + 3
      let depth = 1
      while (k < source.length && depth > 0) {
        const c2 = source[k]
        if (c2 === '\\') { k += 2; continue }
        if (c2 === '[') {
          let j = k + 1
          if (source[j] === '^') j++
          while (j < source.length && source[j] !== ']') {
            if (source[j] === '\\') j += 2
            else j++
          }
          if (source[j] !== ']') return null
          k = j + 1
          continue
        }
        if (c2 === '(') depth++
        else if (c2 === ')') depth--
        k++
      }
      if (depth !== 0) return null
      const body = source.slice(i + 3, k - 1)
      // CSS ident position: `(?:[class]|\\<esc>)` → an escape-aware `run`.
      const escRanges = matchCssEscapeClassAlt(body)
      if (escRanges) {
        flush()
        const q2 = source[k]
        if (q2 === '+') { parts.push({ part: 'run', ranges: escRanges, negated: false, min: 1, unbounded: true, escapes: true }); i = k + 1 }
        else if (q2 === '*') { parts.push({ part: 'run', ranges: escRanges, negated: false, min: 0, unbounded: true, escapes: true }); i = k + 1 }
        else if (q2 === '?') { parts.push({ part: 'run', ranges: escRanges, negated: false, min: 0, unbounded: false, escapes: true }); i = k + 1 }
        else { parts.push({ part: 'run', ranges: escRanges, negated: false, min: 1, unbounded: false, escapes: true }); i = k }
        continue
      }
      const inner = parseScanShape(body)
      if (!inner || !groupInnerSafe(inner)) return null
      const q = source[k]
      // `{n,m}` on a group is a §8c/§8f combination not modeled — decline.
      if (q === '{') return null
      flush()
      if (q === '+') {
        if (shapeCanBeEmpty(inner)) return null // would loop forever — decline
        parts.push({ part: 'group', inner, min: 1, unbounded: true })
        i = k + 1
      } else if (q === '*') {
        if (shapeCanBeEmpty(inner)) return null
        parts.push({ part: 'group', inner, min: 0, unbounded: true })
        i = k + 1
      } else if (q === '?') {
        parts.push({ part: 'group', inner, min: 0, unbounded: false })
        i = k + 1
      } else {
        parts.push({ part: 'group', inner, min: 1, unbounded: false })
        i = k
      }
      continue
    }
    // A bare metachar (`|`, `.`, `{`, stray `*`/`+`/`?`, …) is outside the
    // linear-chain category — bail to the RegExp fallback.
    if (META.has(ch)) return null
    const cp = ch.codePointAt(0)!
    i += ch.length
    if (source[i] === '?') { flush(); parts.push({ part: 'lit', cps: [cp], optional: true }); i++ }
    else lit.push(cp)
  }
  flush()
  return parts.length ? parts : null
}

/**
 * Only lower a `seq` when greedy left-to-right scanning matches EXACTLY what the
 * backtracking regex engine would. The dangerous cases are (a) an optional part
 * that could also be consumed by what follows, and (b) an unbounded/repeated
 * part whose accepted class overlaps what follows — both let the engine
 * backtrack to a different boundary than a one-pass scan. We also require at
 * least one mandatory segment (so the token can't match zero-width).
 *
 * A skippable/repeatable part `p` at index `k` is checked against
 * `seqFirstAccept(parts.slice(k + 1))` — the accept-set of EVERYTHING that
 * could start at the very next position, unioned through any further chain of
 * optionals up to the next mandatory part (the exact same computation
 * `seqFirstAccept` already does for a seq's OWN leading accept-set). This
 * subsumes the simpler "check only the immediate neighbor" rule as the
 * one-part-following case, while also correctly handling a CHAIN of several
 * consecutive optional parts (e.g. two independent optional groups in a row,
 * `(?:\.\d+)?(?:[eE][+-]?\d+)?` — JSON/GraphQL's number tail, §8f): each is
 * safe precisely when disjoint from everything that could follow it, however
 * many further optionals that spans. An empty tail (`p` is the last part)
 * naturally resolves to a trivially-disjoint empty set — nothing to check.
 *
 * Uniform across `lit`/`run`/`group`: each part's own "first char it could
 * start with" (`partFirstAccept`) is compared via `firstSetsDisjoint` — the
 * same subset/disjoint math used everywhere else in this file (§8b's
 * lookahead guard, §8e's alt-dispatch guard).
 */
function seqIsUnambiguous(parts: SeqPart[]): boolean {
  let hasMandatory = false
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]!
    const mandatory = p.part === 'lit' ? !p.optional : p.min === 1
    if (mandatory) hasMandatory = true
    // A `group` part has a right-edge exposure (`groupPartExposure`): the chars a
    // backtracking engine could give back by shrinking the body's own trailing
    // quantifier, dropping the group (if optional/repeated), or — for a
    // non-disjoint alt body — switching arms. Ordered-choice greedy scanning
    // matches the engine only when NONE of those relinquished chars could also
    // start what follows the group (else the scan and the engine disagree on
    // where the group ends). Two outcomes:
    //   - a concrete class → must be disjoint from `seqFirstAccept(rest)`. This
    //     is the general fix for a group whose body ends in an unbounded run
    //     (`(?:\d+)\d` must NOT lower), and it lets a mutually-exclusive fixed
    //     alt (§8i, exposure `null`) lower at ANY position, not just trailing.
    //   - `'unsupported'` → the exposure can't be bounded (e.g. a non-disjoint
    //     alt like `(?:a|ab)` that genuinely needs arm-switching). Sound only
    //     when nothing follows to force reconsideration — the group must be the
    //     trailing, matched-exactly-once part (§8h); otherwise decline.
    if (p.part === 'group') {
      const exposure = groupPartExposure(p)
      if (exposure === 'unsupported') {
        const trailingOnce = k === parts.length - 1 && p.min === 1 && !p.unbounded
        if (!trailingOnce) return false
      } else if (exposure !== null) {
        if (!firstSetsDisjoint(exposure, seqFirstAccept(parts.slice(k + 1)))) return false
      }
    }
    const skippableSingle =
      (p.part === 'lit' && p.optional) || (p.part !== 'lit' && !p.unbounded && p.min === 0)
    const isUnboundedRepeat = p.part !== 'lit' && p.unbounded
    if (skippableSingle || isUnboundedRepeat) {
      const rest = seqFirstAccept(parts.slice(k + 1))
      if (!firstSetsDisjoint(partFirstAccept(p), rest)) return false
    }
  }
  return hasMandatory
}

function rangesOverlap(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  return a.some(([lo, hi]) => b.some(([lo2, hi2]) => lo <= hi2 && lo2 <= hi))
}

/** Is every range in `sub` fully contained in some range of `sup`? */
function rangesSubset(sub: Array<[number, number]>, sup: Array<[number, number]>): boolean {
  return sub.every(([lo, hi]) => sup.some(([lo2, hi2]) => lo >= lo2 && hi <= hi2))
}

/**
 * A `(?!X)`/`(?=X)` operand: a char class (`[...]`, incl. `[^...]`), a
 * shorthand class (`\d`/`\w`/`\s`), or a single literal/escaped char — never a
 * sub-pattern (no alternation, no nested groups). Returns the ranges to test
 * membership against, and whether the bracket itself was negated (`[^...]`) —
 * independent of the lookahead's own `!`/`=` polarity.
 */
function parseClassOperand(body: string): { ranges: Array<[number, number]>; negated: boolean } | null {
  if (body === '\\d' || body === '\\w' || body === '\\s') {
    return { ranges: shorthandRanges(body[1] as 'd' | 'w' | 's'), negated: false }
  }
  if (body.length >= 2 && body[0] === '[' && body[body.length - 1] === ']') {
    let inner = body.slice(1, -1)
    const negated = inner.startsWith('^')
    if (negated) inner = inner.slice(1)
    const ranges = parseClassRanges(inner)
    return ranges ? { ranges, negated } : null
  }
  const cps = literalCodePoints(body)
  if (cps && cps.length === 1) return { ranges: [[cps[0]!, cps[0]!]], negated: false }
  return null
}

type TrailingLookahead = {
  base: string
  ranges: Array<[number, number]>
  classNegated: boolean
  negative: boolean
}

type CharSet = { ranges: Array<[number, number]>; negated: boolean }

/** Is char-set `t` fully contained in char-set `u`? Handles all 4 sign combos. */
function classSubset(t: CharSet, u: CharSet): boolean {
  if (!t.negated && !u.negated) return rangesSubset(t.ranges, u.ranges)
  if (!t.negated && u.negated) return !rangesOverlap(t.ranges, u.ranges) // t ⊆ ¬u ⟺ t ∩ u = ∅
  if (t.negated && !u.negated) return false // ¬t ⊆ u is never true for finite ranges u
  return rangesSubset(u.ranges, t.ranges) // ¬t ⊆ ¬u ⟺ u ⊆ t
}

/** Are char-sets `t` and `u` disjoint (no overlap)? Handles all 4 sign combos. */
function classDisjoint(t: CharSet, u: CharSet): boolean {
  if (!t.negated && !u.negated) return !rangesOverlap(t.ranges, u.ranges)
  if (!t.negated && u.negated) return rangesSubset(t.ranges, u.ranges) // t ∩ ¬u = ∅ ⟺ t ⊆ u
  if (t.negated && !u.negated) return rangesSubset(u.ranges, t.ranges) // symmetric
  return false // ¬t ∩ ¬u = ∅ would require t ∪ u = every code point — can't prove with finite ranges
}

/** `classDisjoint`, `'any'`-aware: an empty-capable part's first-set degrades
 * to `'any'` (see `shapeFirstAccept`), and `'any'` is never disjoint from
 * anything (it could start with literally any char, including whatever the
 * other side accepts). */
function firstSetsDisjoint(a: CharSet | 'any', b: CharSet | 'any'): boolean {
  if (a === 'any' || b === 'any') return false
  return classDisjoint(a, b)
}

/**
 * A shape's match as a fixed-length list of per-position char-sets, or `null`
 * if its match length is NOT fixed. Only a `seq` of mandatory `lit`s (each code
 * point is one fixed position) and mandatory single-char runs (`[x]`, min 1,
 * bounded) qualifies — anything with an optional part, an unbounded/optional
 * run, or a nested group has a variable length and returns `null`. Used to
 * decide when a non-disjoint alternation's arms are mutually exclusive (§8i).
 */
function fixedClassSeq(shape: ScanShape): CharSet[] | null {
  // A case-fold literal is fixed-length: each code point becomes a single-char
  // class holding BOTH ASCII cases (so mutual-exclusivity is judged on what the
  // `/i` match actually accepts — `and` vs `or` are disjoint at position 0).
  if (shape.kind === 'litFold') {
    return shape.open.map(cp => {
      const other = cp >= 65 && cp <= 90 ? cp + 32 : cp >= 97 && cp <= 122 ? cp - 32 : cp
      return other === cp
        ? { ranges: [[cp, cp]] as Array<[number, number]>, negated: false }
        : { ranges: [[Math.min(cp, other), Math.min(cp, other)], [Math.max(cp, other), Math.max(cp, other)]] as Array<[number, number]>, negated: false }
    })
  }
  if (shape.kind !== 'seq') return null
  const out: CharSet[] = []
  for (const p of shape.parts) {
    if (p.part === 'lit') {
      if (p.optional) return null
      for (const cp of p.cps) out.push({ ranges: [[cp, cp]], negated: false })
    } else if (p.part === 'run' && !p.unbounded && p.min === 1 && !p.escapes) {
      // (an escapes run is NOT fixed-length — a `\` escape spans several chars)
      out.push({ ranges: p.ranges, negated: p.negated })
    } else {
      return null // optional/unbounded run, or a nested group — length not fixed
    }
  }
  return out.length ? out : null
}

/**
 * §8i — is a NON-disjoint `alt` shape one whose arms are pairwise MUTUALLY
 * EXCLUSIVE fixed-length token sets? Every arm must be a `fixedClassSeq`, and no
 * arm's match may ever be a prefix (proper, or an equal-length overlap) of
 * another arm's — i.e. for every ordered pair (A, B) with `A.length <= B.length`
 * there is a position within A where their classes are DISJOINT. That property
 * guarantees at most one arm matches at any input position, so ordered-choice
 * commit lands on the SAME arm (and the SAME fixed end) the engine would, with
 * no arm to switch to under backtracking — sound in ANY position, not just
 * trailing (unlike the general non-disjoint alt, which needs the trailing-once
 * gate in `seqIsUnambiguous`). `(?:ab|ac)` and `(?:foo|barn)` qualify;
 * `(?:a|ab)` (arm `a` is a prefix of `ab`) does NOT.
 */
function altFixedMutuallyExclusive(shape: ScanShape): boolean {
  if (shape.kind !== 'alt' || shape.disjoint) return false
  const lists: CharSet[][] = []
  for (const arm of shape.arms) {
    const f = fixedClassSeq(arm)
    if (!f) return false
    lists.push(f)
  }
  for (let i = 0; i < lists.length; i++) {
    for (let j = 0; j < lists.length; j++) {
      if (i === j) continue
      const a = lists[i]!
      const b = lists[j]!
      if (a.length > b.length) continue // only check the shorter (a) as a prefix of the longer (b)
      let disjointAt = false
      for (let p = 0; p < a.length; p++) {
        if (classDisjoint(a[p]!, b[p]!)) { disjointAt = true; break }
      }
      if (!disjointAt) return false // `a` could be a prefix of `b` — not mutually exclusive
    }
  }
  return true
}

/**
 * The char-set a backtracking engine could relinquish at a `group` PART's right
 * edge — its "trailing exposure". Combines two independent backtrack moves: the
 * group body's OWN trailing wiggle (`trailingBacktrackClass(inner)`, e.g. the
 * body ends in an unbounded run), and — if the group is optional (`min 0`) or
 * repeated (`unbounded`) — the "drop the last occurrence" move, which exposes
 * the body's own first-char set. A required-once group (`min 1`, bounded) has
 * only the first move. Returns `'unsupported'` if either component can't be
 * pinned to a concrete set. This is the single computation used everywhere a
 * group's right boundary matters: `trailingBacktrackClass` (a `seq` ending in a
 * group) and `seqIsUnambiguous` (a group at ANY position, followed by more).
 */
function groupPartExposure(part: Extract<SeqPart, { part: 'group' }>): CharSet | null | 'unsupported' {
  const innerWiggle = trailingBacktrackClass(part.inner)
  if (innerWiggle === 'unsupported') return 'unsupported'
  const requiredOnce = !part.unbounded && part.min === 1
  if (requiredOnce) return innerWiggle // no "drop it" move possible — only inner's own wiggle matters
  const dropExposed = shapeFirstAccept(part.inner)
  if (dropExposed === 'any') return 'unsupported'
  if (innerWiggle === null) return dropExposed
  const unioned = unionCharSets([innerWiggle, dropExposed])
  return unioned === 'any' ? 'unsupported' : unioned
}

/**
 * The char-class a backtracking engine could expose by shrinking `shape`'s
 * OWN trailing quantifier by one position — i.e. the "wiggle room" a trailing
 * lookahead could interact with. Returns `null` when `shape`'s matched length
 * is fully fixed once it succeeds (no quantifier to shrink), which makes
 * wrapping it in a lookahead unconditionally safe. Returns `'unsupported'` for
 * shape kinds whose backtracking semantics aren't modeled here (declines the
 * lookahead lowering rather than risking an unproven guard).
 *
 * Only the LAST quantifier matters: `seqIsUnambiguous` already proves every
 * EARLIER part of a `seq` has exactly one valid parse (no alternate length),
 * so the sole remaining freedom a backtracking engine has — once we attach an
 * external trailing lookahead — is in whatever quantifier sits at the very end.
 */
function trailingBacktrackClass(shape: ScanShape): CharSet | null | 'unsupported' {
  if (shape.kind === 'chars') return { ranges: shape.ranges, negated: false }
  if (shape.kind === 'ident') return { ranges: shape.tail, negated: false }
  if (shape.kind === 'litFold') return null // fixed-length literal — no quantifier at all
  if (shape.kind === 'seq') {
    const last = shape.parts[shape.parts.length - 1]!
    if (last.part === 'lit') return null // fixed literal tail — no wiggle room
    if (last.part === 'run') {
      // unbounded (`+`/`*`) or optional-bounded (`[x]?`) both have a
      // 1-position choice a backtracker could make; `[x]` (min 1, bounded) is
      // a single required char — no choice, hence no risk.
      if (last.unbounded || last.min === 0) {
        // An escapes run's right edge can also expose a `\` (escape lead).
        const ranges = last.escapes ? [...last.ranges, [92, 92] as [number, number]] : last.ranges
        return { ranges, negated: last.negated }
      }
      return null
    }
    // A trailing `group` (§8f): its trailing exposure combines its body's own
    // wiggle and (if optional/repeated) the "drop it" move — see
    // `groupPartExposure`, shared with `seqIsUnambiguous`.
    return groupPartExposure(last)
  }
  if (shape.kind === 'alt') {
    // Arm-switching hazard (see `groupInnerSafe`) applies here too: a
    // non-disjoint alt can't be trusted to expose the right wiggle class,
    // since which arm ultimately "wins" could itself change under backtrack.
    // A disjoint alt has no such hazard — exactly one arm is ever reachable
    // from a given starting char, so the union of every arm's OWN wiggle
    // covers whichever one is actually taken. A non-disjoint alt whose arms are
    // fixed-length and mutually exclusive (§8i) also has no wiggle — exactly one
    // arm matches at any position and its length is fixed, so `null`.
    if (!shape.disjoint) return altFixedMutuallyExclusive(shape) ? null : 'unsupported'
    const classes = shape.arms.map(trailingBacktrackClass)
    if (classes.some(c => c === 'unsupported')) return 'unsupported'
    const concrete = classes.filter((c): c is CharSet => c !== null)
    if (concrete.length === 0) return null
    const unioned = unionCharSets(concrete)
    return unioned === 'any' ? 'unsupported' : unioned
  }
  // `until`/`delimited`/`string`/nested `lookahead` — not modeled; decline.
  return 'unsupported'
}

/**
 * Is it safe to lower `inner(?!ranges)` / `inner(?=ranges)` to a one-shot
 * post-match check (vs. requiring real backtracking)? See PERF_IDEAS §8b.
 */
function lookaheadUnambiguous(inner: ScanShape, operand: CharSet, negative: boolean): boolean {
  const tail = trailingBacktrackClass(inner)
  if (tail === 'unsupported') return false
  if (tail === null) return true // inner's length is fixed — no backtracking possible
  // Negative `(?!op)`: safe iff every char the tail could expose is ALSO
  // excluded by `op` (so shrinking never turns a failure into a pass).
  // Positive `(?=op)`: safe iff the tail is disjoint from `op` (so shrinking
  // could never expose a char that suddenly satisfies `op`).
  return negative ? classSubset(tail, operand) : classDisjoint(tail, operand)
}

/**
 * Strip a trailing `(?!class)` / `(?=class)` boundary assertion, if present.
 * Only a TRAILING lookahead with a char-class/single-char operand is
 * recognized — no sub-patterns, no nested groups. Anything else containing an
 * unescaped `(` is left to the other recognizers, which reject it as a
 * metachar (`META`) and fall back to `RegExp.exec`, so a false read here can
 * only fail to lower, never mis-lower.
 */
function stripTrailingLookahead(source: string): TrailingLookahead | null {
  if (!source.endsWith(')')) return null
  for (const negative of [true, false] as const) {
    const lead = negative ? '(?!' : '(?='
    const idx = source.lastIndexOf(lead)
    if (idx === -1) continue
    const body = source.slice(idx + lead.length, -1)
    const operand = body.length ? parseClassOperand(body) : null
    if (!operand) continue
    return { base: source.slice(0, idx), ranges: operand.ranges, classNegated: operand.negated, negative }
  }
  return null
}

/**
 * Strip ONE redundant outer `(?:…)` wrapper, if it spans the ENTIRE source
 * (nothing before it, nothing — not even a quantifier — after its matching
 * close). A non-capturing group with no trailing quantifier is semantically
 * identical to its bare contents, so this is always safe to unwrap; it's what
 * lets `(?:a|b|c)` (a whole-token alternation written as idiomatic regex
 * style, e.g. CSS `basicSel`) reach the top-level `|` split below. Bails
 * (leaves `source` untouched) on anything that isn't a clean whole-string
 * wrap: unbalanced parens, or a group that closes before the string ends
 * (which would mean a quantifier or trailing content follows it).
 */
function unwrapOuterGroup(source: string): string {
  while (source.startsWith('(?:')) {
    let depth = 1
    let i = 3
    let ok = true
    while (i < source.length && depth > 0) {
      const ch = source[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '[') {
        let j = i + 1
        if (source[j] === '^') j++
        while (j < source.length && source[j] !== ']') {
          if (source[j] === '\\') j += 2
          else j++
        }
        if (source[j] !== ']') { ok = false; break }
        i = j + 1
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    if (!ok || depth !== 0 || i !== source.length) break
    source = source.slice(3, -1)
  }
  return source
}

/**
 * Split a regex source on top-level `|` — i.e. `|` outside any `[]` bracket
 * class and outside any `(...)` group (parens still count toward depth even
 * though we don't otherwise understand groups; a `|` nested in one is never a
 * split point). Returns null if there's no top-level `|` at all, if brackets/
 * parens are unbalanced, or if any resulting alternative is empty (a
 * zero-width arm — an unmodeled edge case, decline rather than mis-lower).
 * One redundant whole-string `(?:…)` wrapper is stripped first (see
 * `unwrapOuterGroup`) so `(?:a|b)` splits the same as bare `a|b`.
 */
function splitTopLevelAlternation(source: string): string[] | null {
  const body = unwrapOuterGroup(source)
  const parts: string[] = []
  let depth = 0
  let last = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '[') {
      let j = i + 1
      if (body[j] === '^') j++
      while (j < body.length && body[j] !== ']') {
        if (body[j] === '\\') j += 2
        else j++
      }
      if (body[j] !== ']') return null
      i = j + 1
      continue
    }
    if (ch === '(') { depth++; i++; continue }
    if (ch === ')') { depth--; if (depth < 0) return null; i++; continue }
    if (ch === '|' && depth === 0) {
      parts.push(body.slice(last, i))
      last = i + 1
      i++
      continue
    }
    i++
  }
  if (depth !== 0) return null
  parts.push(body.slice(last))
  if (parts.length < 2 || parts.some(p => p.length === 0)) return null
  return parts
}

/** Can `shape` match the empty string? Only an unbounded `chars` run with no
 * `+` (`[x]*`) can — every other shape requires at least one fixed/mandatory
 * char (`seq` always has ≥1 mandatory part per `seqIsUnambiguous`; `ident`/
 * `until`/`delimited`/`string`/`litFold` all require a fixed opening char). A
 * `lookahead`/`alt` defer to what they wrap. */
function shapeCanBeEmpty(shape: ScanShape): boolean {
  if (shape.kind === 'chars') return !shape.minOne
  if (shape.kind === 'lookahead') return shapeCanBeEmpty(shape.inner)
  if (shape.kind === 'alt') return shape.arms.some(shapeCanBeEmpty)
  return false
}

/** Exact union of char-sets when it's computable, else `'any'` (conservative:
 * forces ordered dispatch rather than guessing at a mixed-polarity union, or
 * when any input is already `'any'`). A single concrete-set list is returned
 * as-is (including if negated) — the ambiguity is only in combining ≥2 sets
 * of differing polarity. */
function unionCharSets(sets: Array<CharSet | 'any'>): CharSet | 'any' {
  if (sets.some(s => s === 'any')) return 'any'
  const concrete = sets as CharSet[]
  if (concrete.length === 1) return concrete[0]!
  if (concrete.some(s => s.negated)) return 'any'
  return { ranges: concrete.flatMap(s => s.ranges), negated: false }
}

/** A single seq part's own first-char set, ignoring whether it's skippable.
 * A `group` part delegates to its inner shape's own first-set (§8f) —
 * possibly `'any'` if the inner shape can match empty or is a non-disjoint
 * `alt` (see `shapeFirstAccept`). */
function partFirstAccept(part: SeqPart): CharSet | 'any' {
  if (part.part === 'lit') return { ranges: [[part.cps[0]!, part.cps[0]!]], negated: false }
  if (part.part === 'run') {
    // An escapes run can also START with a `\` (escape lead).
    const ranges = part.escapes ? [...part.ranges, [92, 92] as [number, number]] : part.ranges
    return { ranges, negated: part.negated }
  }
  return shapeFirstAccept(part.inner)
}

/** The char-set a `seq` can start with: union of each leading skippable part's
 * own set up to and including the first mandatory part (after which later
 * parts can no longer be what the very first input char matches). */
function seqFirstAccept(parts: SeqPart[]): CharSet | 'any' {
  const sets: Array<CharSet | 'any'> = []
  for (const p of parts) {
    const mandatory = p.part === 'lit' ? !p.optional : p.min === 1
    sets.push(partFirstAccept(p))
    if (mandatory) break
  }
  return unionCharSets(sets)
}

/**
 * Is `inner` safe to use as a group's body (§8f)? `chars`/`ident`/`seq`/
 * `litFold` are always safe: each is only ever constructed after proving (via
 * `seqIsUnambiguous` or equivalent) that greedy resolution is the UNIQUE valid
 * match at a given position — there is no alternate length for a backtracker
 * to reconsider, so treating the group as an atomic, resolve-once unit is
 * sound regardless of what follows it. A `lookahead` defers to what it wraps
 * (zero-width, adds no new choice). An `alt` is safe ONLY when `disjoint`:
 * a NON-disjoint alt (`(?:a|ab)`) genuinely can need real backtracking into a
 * DIFFERENT arm if something after the group fails (verified: `/^(?:a|ab)c/`
 * matches "abc" via the SECOND arm, only because the first arm's match left
 * "c" unsatisfied) — our ordered-dispatch codegen resolves once and never
 * reconsiders, so that case must decline. `until`/`delimited`/`string` are
 * declined outright, same conservative call as `trailingBacktrackClass`.
 */
function groupInnerSafe(shape: ScanShape): boolean {
  if (shape.kind === 'chars' || shape.kind === 'ident' || shape.kind === 'seq' || shape.kind === 'litFold') return true
  if (shape.kind === 'lookahead') return groupInnerSafe(shape.inner)
  // A disjoint alt is safe anywhere. A NON-disjoint alt is admitted here too,
  // but its ordered-choice-commit is only sound in the trailing-once position —
  // `seqIsUnambiguous` (§8h) enforces that positional constraint; a non-trailing
  // or optional/repeated non-disjoint-alt group is rejected there.
  if (shape.kind === 'alt') return true
  return false
}

/**
 * The set of first chars a NON-EMPTY match of `shape` could start with, or
 * `'any'` if that can't be pinned down to a single char-set (used to decide
 * whether `alt` arms have disjoint first-sets). A shape that can match empty
 * degrades to `'any'`: since it could succeed with zero chars regardless of
 * what follows, it would "accept" any first char by never actually needing one
 * — treating that as disjoint from anything else would be unsound.
 */
function shapeFirstAccept(shape: ScanShape): CharSet | 'any' {
  if (shapeCanBeEmpty(shape)) return 'any'
  switch (shape.kind) {
    case 'chars': return { ranges: shape.ranges, negated: false }
    case 'ident': return { ranges: shape.head, negated: false }
    case 'until': return { ranges: [[shape.open[0]!, shape.open[0]!]], negated: false }
    case 'delimited': return { ranges: [[shape.open[0]!, shape.open[0]!]], negated: false }
    case 'string': return { ranges: [[shape.quote, shape.quote]], negated: false }
    case 'litFold': {
      const cp = shape.open[0]!
      if (cp >= 65 && cp <= 90) return { ranges: [[cp, cp], [cp + 32, cp + 32]], negated: false }
      if (cp >= 97 && cp <= 122) return { ranges: [[cp, cp], [cp - 32, cp - 32]], negated: false }
      return { ranges: [[cp, cp]], negated: false }
    }
    case 'seq': return seqFirstAccept(shape.parts)
    case 'lookahead': return shapeFirstAccept(shape.inner) // zero-width — doesn't change first-char acceptance
    case 'alt': {
      // The set of first chars is the union of every arm's own first-set,
      // independent of whether the arms are mutually disjoint (that flag only
      // governs dispatch, not what the shape can start with). Any arm whose
      // first-set is itself `'any'` (stored as `null`) makes the union `'any'`.
      const sets = shape.firsts.map((f): CharSet | 'any' => (f === null ? 'any' : f))
      return unionCharSets(sets)
    }
  }
}

/** True iff every pair of `sets` is provably disjoint; `'any'` is disjoint from nothing. */
function allPairsDisjoint(sets: Array<CharSet | 'any'>): boolean {
  for (let i = 0; i < sets.length; i++) {
    const a = sets[i]!
    if (a === 'any') return false
    for (let j = i + 1; j < sets.length; j++) {
      const b = sets[j]!
      if (b === 'any' || !classDisjoint(a, b)) return false
    }
  }
  return true
}

/**
 * Recognize top-level alternation `A|B|C` (§8e): split on `|` outside any
 * `[]`/`()`, lower each arm independently (an arm may itself be a `seq`,
 * `chars`, `lookahead`, …, or even nested alternation via one redundant
 * `(?:…)` wrapper — see `unwrapOuterGroup`). Declines (null) unless EVERY arm
 * independently lowers — a single unsupported arm (e.g. one with a nested
 * capturing/non-capturing group, §8f) falls the whole alternation back to
 * `RegExp.exec` rather than partially lowering.
 */
function parseAlternation(source: string): ScanShape | null {
  const parts = splitTopLevelAlternation(source)
  if (!parts) return null
  const arms: ScanShape[] = []
  for (const p of parts) {
    const arm = parseScanShape(p)
    if (!arm) return null
    arms.push(arm)
  }
  const firstSets = arms.map(shapeFirstAccept)
  const disjoint = allPairsDisjoint(firstSets)
  return { kind: 'alt', arms, disjoint, firsts: firstSets.map(f => (f === 'any' ? null : f)) }
}

/**
 * Recognize one scannable arm from its regex source, or null if it isn't one of
 * the structural shapes. Top-level alternation (§8e) is tried FIRST — `|` has
 * the lowest precedence in regex, so splitting on it happens before anything
 * else, with each arm then recursively re-entering this same function (so an
 * arm's own trailing lookahead, or its own nested `(?:…)`-wrapped alternation,
 * is still recognized). Failing that: char-class run, ident, string, then
 * open-until-terminator, delimited, and finally the general linear `seq` chain.
 * A trailing `(?!class)`/`(?=class)` is peeled off next (§8b) and re-wraps
 * whatever shape the remaining base recognizes as.
 */
export function parseScanShape(source: string): ScanShape | null {
  const alt = parseAlternation(source)
  if (alt) return alt
  const la = stripTrailingLookahead(source)
  if (la) {
    const inner = parseScanShapeCore(la.base)
    if (!inner) return null
    const operand: CharSet = { ranges: la.ranges, negated: la.classNegated }
    if (!lookaheadUnambiguous(inner, operand, la.negative)) return null
    return { kind: 'lookahead', inner, ranges: la.ranges, classNegated: la.classNegated, negative: la.negative }
  }
  return parseScanShapeCore(source)
}

/**
 * Split a regex fragment on top-level `|` (outside `[]`/`()`), escape-aware.
 * Unlike `splitTopLevelAlternation` this allows a SINGLE arm (no `|` at all) and
 * does not unwrap an outer group — it's used to enumerate the arms of a
 * `delimited` body, which may legitimately be one bare arm (`[^x]`). Returns
 * null on unbalanced brackets/parens.
 */
function splitDelimArms(body: string): string[] | null {
  const arms: string[] = []
  let depth = 0
  let last = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '[') {
      let j = i + 1
      if (body[j] === '^') j++
      while (j < body.length && body[j] !== ']') {
        if (body[j] === '\\') j += 2
        else j++
      }
      if (body[j] !== ']') return null
      i = j + 1
      continue
    }
    if (ch === '(') { depth++; i++; continue }
    if (ch === ')') { depth--; if (depth < 0) return null; i++; continue }
    if (ch === '|' && depth === 0) { arms.push(body.slice(last, i)); last = i + 1 }
    i++
  }
  if (depth !== 0) return null
  arms.push(body.slice(last))
  return arms
}

/**
 * Prove that the `delimited` lowering — "scan the raw input to the first full
 * `close` literal, ignoring the body entirely" — is EQUIVALENT to the real regex
 * `<open>(?:body)*<close>`. That equivalence holds iff `(?:body)*` can never
 * match a string that contains the `close` literal: then greedy repetition stops
 * exactly before the first `close`, which is where the scan lands too.
 *
 * We only PROVE this for the block-comment idiom (the sole shape that expresses
 * "any char that doesn't form the close"):
 *
 *   n === 1 (`close` is one char l0):   body must be exactly `[^l0]`.
 *   n === 2 (`close` is `l0 l1`):       body must be exactly `[^l0] | l0(?!l1)`.
 *
 * In both the bulk arm `[^l0]` consumes every char except l0, and the guard arm
 * (n === 2) consumes l0 only when it is NOT followed by l1 — so the body admits
 * l0 but never the full `l0 l1`, and rejects NOTHING else (a body that excluded
 * some non-close char would stop early while the raw scan skipped ahead to the
 * next close, diverging). Anything outside this template — an alternation whose
 * arms can consume the close (`z(?:a|[0-2]+)*a`), a bulk class narrower/wider
 * than `[^l0]`, a longer close, extra arms — is declined, falling through to
 * `RegExp.exec`. Sound-by-construction: we only ever return true for a body we
 * can prove never contains `close`.
 */
function delimitedBodySound(body: string, close: number[]): boolean {
  const l0 = close[0]!
  if (close.length > 2) return false
  const arms = splitDelimArms(body)
  if (!arms) return false
  let bulkSeen = false
  let guardSeen = false
  for (const arm of arms) {
    // Bulk arm: a bare negated class `[^l0]` — excluded set is exactly {l0}.
    const bulk = /^\[\^((?:\\.|[^\]])+)\]$/.exec(arm)
    if (bulk) {
      if (bulkSeen) return false
      const ranges = parseClassRanges(bulk[1]!)
      if (!ranges || ranges.length !== 1 || ranges[0]![0] !== l0 || ranges[0]![1] !== l0) return false
      bulkSeen = true
      continue
    }
    // Guard arm (n === 2 only): `l0(?!l1)` — consume l0 unless it starts the close.
    if (close.length === 2 && arm.endsWith(')')) {
      const idx = arm.indexOf('(?!')
      if (idx === -1) return false
      const prefix = literalCodePoints(arm.slice(0, idx))
      const op = parseClassOperand(arm.slice(idx + 3, -1))
      const prefixIsL0 = prefix?.length === 1 && prefix[0] === l0
      const forbidsL1 = op && !op.negated && op.ranges.length === 1 &&
        op.ranges[0]![0] === close[1] && op.ranges[0]![1] === close[1]
      if (!prefixIsL0 || !forbidsL1 || guardSeen) return false
      guardSeen = true
      continue
    }
    return false
  }
  // Require the exact arm set: bulk always; guard iff the close is two chars.
  return bulkSeen && guardSeen === (close.length === 2)
}

/**
 * Structurally recognize `<openLit>(?:<body>)*<closeLit>` — literal opener, a
 * single non-capturing `*`-repeated group, literal closer — and lower it to a
 * `delimited` scan ONLY when `delimitedBodySound` proves the body can't contain
 * the close. Returns null (→ fall through to `seq`/`RegExp.exec`) otherwise.
 */
function parseDelimited(source: string): ScanShape | null {
  // An escape-aware body (a literal `\\` in the source ⇒ string-like) is handled
  // by `parseStringShape`; here "scan to first close" would wrongly stop at an
  // escaped delimiter, so decline.
  if (source.includes('\\\\')) return null
  // Opener: literal chars up to the first unescaped `(`, which must open `(?:`.
  let i = 0
  while (i < source.length && source[i] !== '(') {
    i += source[i] === '\\' ? 2 : 1
  }
  if (source[i] !== '(' || source[i + 1] !== '?' || source[i + 2] !== ':') return null
  const openFrag = source.slice(0, i)
  // Balanced scan of the group body to its matching `)`.
  let k = i + 3
  let depth = 1
  while (k < source.length && depth > 0) {
    const ch = source[k]
    if (ch === '\\') { k += 2; continue }
    if (ch === '[') {
      let j = k + 1
      if (source[j] === '^') j++
      while (j < source.length && source[j] !== ']') {
        if (source[j] === '\\') j += 2
        else j++
      }
      if (source[j] !== ']') return null
      k = j + 1
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    k++
  }
  if (depth !== 0) return null
  const body = source.slice(i + 3, k - 1)
  if (source[k] !== '*') return null
  const closeFrag = source.slice(k + 1)
  const open = literalCodePoints(openFrag)
  const close = literalCodePoints(closeFrag)
  if (!open || !close || !delimitedBodySound(body, close)) return null
  return { kind: 'delimited', open, close }
}

function parseScanShapeCore(source: string): ScanShape | null {
  // [X]+ / [X]* — a positive char-class run. A negated `[^X]+`/`[^X]*` is left to
  // the general `seq` path (which lowers `[^X]+` and declines zero-width `[^X]*`).
  let m = /^\[((?:\\.|[^\]])+)\]([+*])$/.exec(source)
  if (m && !m[1]!.startsWith('^')) {
    const ranges = parseClassRanges(m[1]!)
    return ranges ? { kind: 'chars', ranges, minOne: m[2] === '+' } : null
  }
  // \d+ / \w+ / \s+ / \d* / \w* / \s* — a bare shorthand-class run.
  m = /^\\([dws])([+*])$/.exec(source)
  if (m) {
    return { kind: 'chars', ranges: shorthandRanges(m[1] as 'd' | 'w' | 's'), minOne: m[2] === '+' }
  }
  // <head><tail>* — identifier run: one head char, then a run of tail chars.
  m = /^(\[(?:\\.|[^\]])+\]|\\[dws])(\[(?:\\.|[^\]])+\]|\\[dws])\*$/.exec(source)
  if (m) {
    const head = classToRanges(m[1]!)
    const tail = classToRanges(m[2]!)
    if (head && tail) return { kind: 'ident', head, tail }
  }
  // <q>(?:[^q\\]|\\.)*<q> — a quote-delimited string with escapes.
  const str = parseStringShape(source)
  if (str) return str
  // <lit>[^X]* — consume a literal opener, then run until a terminator char.
  m = /^(.*?)\[\^((?:\\.|[^\]])+)\]\*$/.exec(source)
  if (m) {
    const open = literalCodePoints(m[1]!)
    const stop = parseClassRanges(m[2]!)
    if (open && stop) return { kind: 'until', open, stop }
  }
  // <open>(?:…)*<close> — delimited token scanned to its first close literal.
  // Only lowered when the body provably can't contain the close (see
  // `parseDelimited` / `delimitedBodySound`); any other `X(?:…)*Y` declines here
  // and falls through to the `seq` path / `RegExp.exec`.
  const delim = parseDelimited(source)
  if (delim) return delim
  // General category: a linear chain of literals + char runs (optional prefixes,
  // literal openers, negated runs), lowered only when unambiguously greedy.
  const parts = parseSeqParts(source)
  if (parts && seqIsUnambiguous(parts)) return { kind: 'seq', parts }
  return null
}

/**
 * Flag-aware wrapper around `parseScanShape`. Lowering to a raw code-point scan
 * assumes default regex semantics, so any flag that changes matching (`i` case
 * folding, `u` surrogate handling, `m`/`s` anchor/dot behavior) disables it.
 * `g`/`y` are stickiness-only and safe.
 */
export function scanShapeFromRegex(source: string, flags: string): ScanShape | null {
  if (/[msu]/.test(flags)) return null
  if (/i/.test(flags)) return caseFoldShape(source)
  return parseScanShape(source)
}

/**
 * Case-insensitive (`/i`) scannable shapes. Beyond a pure case-fold literal
 * (`litFold`), this recognizes a top-level alternation of literals (an ordered
 * `alt` of litFolds — CSS `(?:and|or)`, `(?:media|container|supports)`), each
 * optionally wrapped in a trailing lookahead boundary (`(?![-\w])`, `(?=\()`).
 * That last form is the regex spelling of `makeWord` — a keyword plus a word
 * boundary — the common CSS at-rule/keyword dispatcher. Anything else declines
 * (→ `RegExp.exec`); a false read here can only fail to lower, never mis-lower.
 */
function caseFoldShape(source: string): ScanShape | null {
  const la = stripTrailingLookahead(source)
  if (la) {
    const inner = caseFoldLiteralOrAlt(la.base)
    if (!inner) return null
    const operand: CharSet = { ranges: la.ranges, negated: la.classNegated }
    if (!lookaheadUnambiguous(inner, operand, la.negative)) return null
    return { kind: 'lookahead', inner, ranges: la.ranges, classNegated: la.classNegated, negative: la.negative }
  }
  return caseFoldLiteralOrAlt(source)
}

/** A case-fold literal, or a top-level `a|b|c` alternation of pure literals. */
function caseFoldLiteralOrAlt(source: string): ScanShape | null {
  const open = literalCodePoints(source)
  if (open) return { kind: 'litFold', open }
  const arms = splitTopLevelAlternation(unwrapOuterGroup(source))
  if (!arms || arms.length < 2) return null
  const litArms: ScanShape[] = []
  for (const arm of arms) {
    const cp = literalCodePoints(arm)
    if (!cp) return null
    litArms.push({ kind: 'litFold', open: cp })
  }
  // Ordered choice: each litFold arm case-folds on its own, so skipping the
  // first-char dispatch guard (disjoint:false, firsts:null) is always correct —
  // it just tries arms in order, exactly like regex `|`.
  return { kind: 'alt', arms: litArms, disjoint: false, firsts: litArms.map(() => null) }
}

export const classCond = (cVar: string, ranges: Array<[number, number]>): string =>
  ranges
    .map(([lo, hi]) => (lo === hi ? `${cVar} === ${lo}` : `(${cVar} >= ${lo} && ${cVar} <= ${hi})`))
    .join(' || ')

/** Literal-match condition at `base + k` for each code point; uses `firstVar` at offset 0. */
export const litCond = (base: string, cps: number[], firstVar?: string): string =>
  cps
    .map((cp, k) =>
      k === 0 && firstVar
        ? `${firstVar} === ${cp}`
        : `input.charCodeAt(${base}${k ? ` + ${k}` : ''}) === ${cp}`,
    )
    .join(' && ')

/** Line-terminator code points `.` does not match (`\n \r \u2028 \u2029`). */
export const LINE_TERMINATORS = [10, 13, 8232, 8233] as const

/** The body-stop chars that abort a string match (excluded set minus quote/backslash). */
export function stringHardStop(
  shape: Extract<ScanShape, { kind: 'string' }>,
): Array<[number, number]> {
  return shape.excluded.filter(
    ([lo, hi]) => !(lo === hi && (lo === shape.quote || lo === BACKSLASH)),
  )
}

/** Mints a fresh, unique local variable name (`prefix` + counter). */
export type Mint = (prefix?: string) => string

/**
 * The SINGLE source of truth for how a scannable shape matches at `start`. Both
 * the terminal emitter and the trivia scan loop consume this, so no context can
 * silently reinterpret an incomplete match (e.g. an unterminated string):
 *
 *   - `setup`   statements (indented by `ind`) that compute the match.
 *   - `ok`      a boolean expr: did a token match at `start`? (zero-width for
 *               `chars*` counts as a match — terminals allow it.)
 *   - `end`     the position AFTER the token. **Invariant:** `end === start`
 *               whenever there is no progress (match failed or matched empty),
 *               so the trivia loop can gate purely on `end > start`.
 *
 * `firstChar`, when supplied, is an expression already equal to
 * `charCodeAt(start)` (the trivia loop reads it once and shares it).
 */
export type ShapeMatch = { setup: string[]; ok: string; end: string }

const codeAt = (start: string, firstChar?: string): string =>
  firstChar ?? `input.charCodeAt(${start})`

// Dispatch-planning thresholds for a disjoint alt's first-char `switch` — same
// tuning as codegen's `planDisjointDispatch` (kept local to avoid a scannable-run
// → codegen import cycle): only worth a jump table when every arm keys off a few
// DISCRETE points; a wide range (`[a-z]+`) would explode into dozens of cases.
const ALT_SWITCH_RANGE_LIMIT = 4
const ALT_SWITCH_MAX_CASES = 48
const ALT_SWITCH_MIN_CASES = 3

/**
 * A `switch` jump table for a *disjoint* alt when every arm's first-set is a few
 * discrete code points (operator/keyword first chars); else `{ kind: 'if' }` to
 * keep the range-comparison `if/else if` chain. Arms are pairwise-disjoint, so
 * each code point maps to exactly one arm.
 */
function planAltSwitch(firsts: Array<CharSet | null>): { kind: 'switch'; cases: number[][] } | { kind: 'if' } {
  const cases: number[][] = []
  let total = 0
  for (const fs of firsts) {
    if (!fs || fs.negated) return { kind: 'if' } // any / negated → no discrete keys
    const pts: number[] = []
    for (const [lo, hi] of fs.ranges) {
      if (hi - lo + 1 > ALT_SWITCH_RANGE_LIMIT) return { kind: 'if' }
      for (let cp = lo; cp <= hi; cp++) pts.push(cp)
    }
    total += pts.length
    if (total > ALT_SWITCH_MAX_CASES) return { kind: 'if' }
    cases.push(pts)
  }
  return total >= ALT_SWITCH_MIN_CASES ? { kind: 'switch', cases } : { kind: 'if' }
}

export function emitShapeMatch(
  shape: ScanShape,
  start: string,
  mint: Mint,
  ind: string,
  firstChar?: string,
): ShapeMatch {
  if (shape.kind === 'lookahead') {
    const inner = emitShapeMatch(shape.inner, start, mint, ind, firstChar)
    const okV = mint('_ok')
    const endV = mint('_end')
    // `charInClass` folds the operand's OWN `[^…]` negation in; `guardFails`
    // then applies the lookahead's `!`/`=` polarity on top. Zero-width: `end`
    // is always `inner.end` (on success) or `start` (on failure) — never past
    // where `inner` itself stopped.
    const rawIn = classCond(`input.charCodeAt(${inner.end})`, shape.ranges)
    const charInClass = shape.classNegated ? `!(${rawIn})` : `(${rawIn})`
    const hasMatchingChar = `${inner.end} < input.length && ${charInClass}`
    const guardFails = shape.negative ? hasMatchingChar : `!(${hasMatchingChar})`
    return {
      setup: [
        ...inner.setup,
        `${ind}let ${okV} = ${inner.ok}`,
        `${ind}let ${endV} = ${inner.end}`,
        `${ind}if (${okV} && (${guardFails})) { ${okV} = false; ${endV} = ${start} }`,
      ],
      ok: okV,
      end: endV,
    }
  }

  if (shape.kind === 'alt') {
    const okV = mint('_ok')
    const endV = mint('_end')
    const lines: string[] = [`${ind}let ${okV} = false`, `${ind}let ${endV} = ${start}`]
    // Fast path: an alternation of case-fold literals (CSS keyword lists like
    // `@media|@container|@supports`, `even|odd`) → a `switch` on the first char
    // that jumps straight to the matching group, tails compared with the bit-OR
    // fold. Measured ~2.4x over the ordered if-chain / ~1.4x over per-arm bit-OR.
    // Ordered-choice is preserved: arms are grouped by their FOLDED first code
    // point and, within a group, emitted in source order (first match wins);
    // arms in different groups can't both match a given first char.
    if (shape.arms.length >= 2 && shape.arms.every(a => a.kind === 'litFold' && a.open.length >= 1)) {
      const groups = new Map<number, number[][]>()
      for (const a of shape.arms) {
        const open = (a as Extract<ScanShape, { kind: 'litFold' }>).open
        const f = open[0]!
        const lower = f >= 65 && f <= 90 ? f + 32 : f
        ;(groups.get(lower) ?? groups.set(lower, []).get(lower)!).push(open)
      }
      lines.push(`${ind}if (${start} < input.length) switch (${codeAt(start, firstChar)}) {`)
      for (const [lower, arms] of groups) {
        const labels = lower >= 97 && lower <= 122 ? `case ${lower}: case ${lower - 32}:` : `case ${lower}:`
        lines.push(`${ind}  ${labels} {`)
        for (const open of arms) {
          const tail = open.slice(1).map((cp, i) => foldEq(`input.charCodeAt(${start} + ${i + 1})`, cp))
          const cond = tail.length ? ` && ${tail.join(' && ')}` : ''
          lines.push(`${ind}    if (${start} + ${open.length} <= input.length${cond}) { ${okV} = true; ${endV} = ${start} + ${open.length}; break }`)
        }
        lines.push(`${ind}    break`)
        lines.push(`${ind}  }`)
      }
      lines.push(`${ind}}`)
      return { setup: lines, ok: okV, end: endV }
    }
    if (shape.disjoint) {
      // Mutually exclusive first-sets: dispatch straight to the one matching
      // arm, no ordering/backtracking concerns (§7b-style disjoint dispatch). A
      // `switch` jump table when arms key off discrete first chars, else the
      // range-comparison `if/else if` chain (same plan as codegen's choice()).
      const plan = planAltSwitch(shape.firsts)
      if (plan.kind === 'switch') {
        lines.push(`${ind}if (${start} < input.length) switch (${codeAt(start, firstChar)}) {`)
        shape.arms.forEach((arm, k) => {
          const labels = plan.cases[k]!.map(cp => `case ${cp}:`).join(' ')
          const m = emitShapeMatch(arm, start, mint, `${ind}    `, firstChar)
          lines.push(`${ind}  ${labels} {`)
          lines.push(...m.setup)
          lines.push(`${ind}    ${okV} = ${m.ok}`)
          lines.push(`${ind}    ${endV} = ${m.ok} ? ${m.end} : ${start}`)
          lines.push(`${ind}    break`)
          lines.push(`${ind}  }`)
        })
        lines.push(`${ind}}`)
      } else {
        const c0 = codeAt(start, firstChar)
        shape.arms.forEach((arm, k) => {
          const fs = shape.firsts[k]! // non-null whenever `disjoint` is true
          const cond = fs.negated ? `!(${classCond(c0, fs.ranges)})` : `(${classCond(c0, fs.ranges)})`
          const m = emitShapeMatch(arm, start, mint, `${ind}  `, firstChar)
          lines.push(`${ind}${k === 0 ? 'if' : 'else if'} (${start} < input.length && ${cond}) {`)
          lines.push(...m.setup)
          lines.push(`${ind}  ${okV} = ${m.ok}`)
          lines.push(`${ind}  ${endV} = ${m.ok} ? ${m.end} : ${start}`)
          lines.push(`${ind}}`)
        })
      }
    } else {
      // Overlapping first-sets: ordered choice — try each arm in turn and take
      // the first that succeeds. This is exactly regex `|`'s own semantics:
      // first alternative to match AT ALL wins on ITS OWN greedy length, never
      // compared against a later alternative's (possibly longer) match.
      const lbl = mint('_alt')
      lines.push(`${ind}${lbl}: {`)
      for (const arm of shape.arms) {
        const m = emitShapeMatch(arm, start, mint, `${ind}  `, firstChar)
        lines.push(...m.setup)
        lines.push(`${ind}  if (${m.ok}) { ${okV} = true; ${endV} = ${m.end}; break ${lbl} }`)
      }
      lines.push(`${ind}}`)
    }
    return { setup: lines, ok: okV, end: endV }
  }

  if (shape.kind === 'chars') {
    const cur = mint('_e')
    return {
      setup: [
        `${ind}let ${cur} = ${start}`,
        `${ind}while (${cur} < input.length && (${classCond(`input.charCodeAt(${cur})`, shape.ranges)})) ${cur}++`,
      ],
      // `*` always matches (possibly empty); `+` needs at least one char.
      ok: shape.minOne ? `${cur} > ${start}` : 'true',
      end: cur,
    }
  }

  if (shape.kind === 'ident') {
    const cur = mint('_e')
    return {
      setup: [
        `${ind}let ${cur} = ${start}`,
        `${ind}if (${start} < input.length && (${classCond(codeAt(start, firstChar), shape.head)})) {`,
        `${ind}  ${cur} = ${start} + 1`,
        `${ind}  while (${cur} < input.length && (${classCond(`input.charCodeAt(${cur})`, shape.tail)})) ${cur}++`,
        `${ind}}`,
      ],
      ok: `${cur} > ${start}`,
      end: cur,
    }
  }

  if (shape.kind === 'seq') {
    const endV = mint('_e')
    const okV = mint('_ok')
    const runCond = (p: Extract<SeqPart, { part: 'run' }>, at: string) => {
      const c = classCond(`input.charCodeAt(${at})`, p.ranges)
      return p.negated ? `!(${c})` : `(${c})`
    }
    // ── escape-aware run helpers (CSS ident position: class char OR CSS escape) ──
    const HEX = (c: string) => `((${c} >= 48 && ${c} <= 57) || (${c} >= 65 && ${c} <= 70) || (${c} >= 97 && ${c} <= 102))`
    const WS = (c: string) => `(${c} === 32 || ${c} === 9 || ${c} === 10 || ${c} === 12 || ${c} === 13)`
    // A valid escape starts at `at` when it's `\` followed by a non-newline char.
    const escStart = (at: string) => `input.charCodeAt(${at}) === 92 && ${at} + 1 < input.length && input.charCodeAt(${at} + 1) !== 10`
    // Statements (indent `bi`) that consume a CSS escape once `endV` points at `\`:
    // 1–6 hex + optional single whitespace, else one non-newline char.
    const escConsume = (bi: string): string[] => {
      const hv = mint('_h')
      return [
        `${bi}${endV}++`,
        `${bi}if (${HEX(`input.charCodeAt(${endV})`)}) {`,
        `${bi}  let ${hv} = 0`,
        `${bi}  while (${hv} < 6 && ${endV} < input.length && ${HEX(`input.charCodeAt(${endV})`)}) { ${endV}++; ${hv}++ }`,
        `${bi}  if (${endV} < input.length && ${WS(`input.charCodeAt(${endV})`)}) ${endV}++`,
        `${bi}} else { ${endV}++ }`,
      ]
    }
    const lines = [`${ind}let ${endV} = ${start}`, `${ind}let ${okV} = false`, `${ind}do {`]
    let first = true
    for (const p of shape.parts) {
      if (p.part === 'lit') {
        const L = p.cps.length
        const cond = litCond(endV, p.cps, first ? firstChar : undefined)
        if (p.optional) {
          lines.push(`${ind}  if (${endV} + ${L} <= input.length && (${cond})) ${endV} += ${L}`)
        } else {
          lines.push(`${ind}  if (!(${endV} + ${L} <= input.length && (${cond}))) break`)
          lines.push(`${ind}  ${endV} += ${L}`)
        }
      } else if (p.part === 'run' && p.escapes) {
        // One position (bounded) or a run (unbounded) of class-char-OR-CSS-escape.
        if (!p.unbounded) {
          lines.push(`${ind}  if (${endV} < input.length && ${runCond(p, endV)}) ${endV}++`)
          lines.push(`${ind}  else if (${escStart(endV)}) {`)
          lines.push(...escConsume(`${ind}    `))
          lines.push(`${ind}  }${p.min === 1 ? ' else break' : ''}`)
        } else {
          const s = mint('_s')
          lines.push(`${ind}  const ${s} = ${endV}`)
          lines.push(`${ind}  while (${endV} < input.length) {`)
          lines.push(`${ind}    if (${runCond(p, endV)}) { ${endV}++; continue }`)
          lines.push(`${ind}    if (${escStart(endV)}) {`)
          lines.push(...escConsume(`${ind}      `))
          lines.push(`${ind}      continue`)
          lines.push(`${ind}    }`)
          lines.push(`${ind}    break`)
          lines.push(`${ind}  }`)
          if (p.min === 1) lines.push(`${ind}  if (${endV} === ${s}) break`)
        }
      } else if (p.part === 'run' && !p.unbounded) {
        // Exactly one char: required (min 1) or optional (min 0).
        if (p.min === 1) {
          lines.push(`${ind}  if (!(${endV} < input.length && ${runCond(p, endV)})) break`)
          lines.push(`${ind}  ${endV}++`)
        } else {
          lines.push(`${ind}  if (${endV} < input.length && ${runCond(p, endV)}) ${endV}++`)
        }
      } else if (p.part === 'run') {
        const s = mint('_s')
        lines.push(`${ind}  const ${s} = ${endV}`)
        lines.push(`${ind}  while (${endV} < input.length && ${runCond(p, endV)}) ${endV}++`)
        if (p.min === 1) lines.push(`${ind}  if (${endV} === ${s}) break`)
      } else {
        // `group` (§8f): the group's own body is just another `ScanShape` —
        // recurse via `emitShapeMatch`, then splice its setup in as the body
        // of a required-once check, an optional take, or a repeat loop.
        const inner = emitShapeMatch(p.inner, endV, mint, `${ind}  `, first ? firstChar : undefined)
        if (!p.unbounded) {
          lines.push(...inner.setup)
          if (p.min === 1) {
            lines.push(`${ind}  if (!(${inner.ok})) break`)
            lines.push(`${ind}  ${endV} = ${inner.end}`)
          } else {
            lines.push(`${ind}  if (${inner.ok}) ${endV} = ${inner.end}`)
          }
        } else {
          const progV = mint('_prog')
          lines.push(`${ind}  let ${progV} = false`)
          lines.push(`${ind}  while (true) {`)
          lines.push(...inner.setup)
          lines.push(`${ind}    if (!(${inner.ok})) break`)
          lines.push(`${ind}    ${endV} = ${inner.end}`)
          lines.push(`${ind}    ${progV} = true`)
          lines.push(`${ind}  }`)
          if (p.min === 1) lines.push(`${ind}  if (!${progV}) break`)
        }
      }
      first = false
    }
    lines.push(`${ind}  ${okV} = true`)
    lines.push(`${ind}} while (false)`)
    lines.push(`${ind}if (!${okV}) ${endV} = ${start}`)
    return { setup: lines, ok: okV, end: endV }
  }

  if (shape.kind === 'litFold') {
    const openLen = shape.open.length
    const endV = mint('_end')
    const checks = shape.open.map((cp, k) => {
      const cVar = k === 0 && firstChar ? firstChar : `input.charCodeAt(${start} + ${k})`
      return foldEq(cVar, cp)
    })
    return {
      setup: [
        `${ind}let ${endV} = ${start}`,
        `${ind}if (${start} + ${openLen} <= input.length && (${checks.join(' && ')})) ${endV} = ${start} + ${openLen}`,
      ],
      ok: `${endV} > ${start}`,
      end: endV,
    }
  }

  if (shape.kind === 'until') {
    const j = mint('_j')
    const openLen = shape.open.length
    const openChk = openLen === 1
      ? `${codeAt(start, firstChar)} === ${shape.open[0]}`
      : litCond(start, shape.open, firstChar)
    return {
      setup: [
        `${ind}let ${j} = ${start}`,
        `${ind}if (${start} + ${openLen} <= input.length && (${openChk})) {`,
        `${ind}  ${j} = ${start} + ${openLen}`,
        `${ind}  while (${j} < input.length && !(${classCond(`input.charCodeAt(${j})`, shape.stop)})) ${j}++`,
        `${ind}}`,
      ],
      // An open-until-terminator always completes (stop char or EOF), so a matched
      // open literal is a full match; `end === start` iff the open didn't match.
      ok: `${j} > ${start}`,
      end: j,
    }
  }

  if (shape.kind === 'string') {
    const okV = mint('_ok')
    const endV = mint('_end')
    const i = mint('_i')
    const c2 = mint('_c')
    const hard = stringHardStop(shape)
    const ltLines = shape.escLineTerm
      ? []
      : (() => {
          const c3 = mint('_c')
          return [
            `${ind}      const ${c3} = input.charCodeAt(${i} + 1)`,
            `${ind}      if (${LINE_TERMINATORS.map(t => `${c3} === ${t}`).join(' || ')}) break`,
          ]
        })()
    return {
      setup: [
        `${ind}let ${okV} = false`,
        `${ind}let ${endV} = ${start}`,
        `${ind}if (${start} < input.length && (${codeAt(start, firstChar)}) === ${shape.quote}) {`,
        `${ind}  let ${i} = ${start} + 1`,
        `${ind}  while (${i} < input.length) {`,
        `${ind}    const ${c2} = input.charCodeAt(${i})`,
        `${ind}    if (${c2} === ${shape.quote}) { ${okV} = true; ${endV} = ${i} + 1; break }`,
        `${ind}    if (${c2} === ${BACKSLASH}) {`,
        `${ind}      if (${i} + 1 >= input.length) break`,
        ...ltLines,
        `${ind}      ${i} += 2`,
        `${ind}      continue`,
        `${ind}    }`,
        ...(hard.length ? [`${ind}    if (${classCond(c2, hard)}) break`] : []),
        `${ind}    ${i}++`,
        `${ind}  }`,
        `${ind}}`,
      ],
      ok: okV,
      end: endV,
    }
  }

  // delimited: <open>…<close>, requires the close literal (unclosed ⇒ no match).
  const j = mint('_j')
  const endV = mint('_end')
  const openLen = shape.open.length
  const closeLen = shape.close.length
  const openChk = openLen === 1
    ? `${codeAt(start, firstChar)} === ${shape.open[0]}`
    : litCond(start, shape.open, firstChar)
  const closeChk = litCond(j, shape.close)
  return {
    setup: [
      `${ind}let ${j} = ${start}`,
      `${ind}let ${endV} = ${start}`,
      `${ind}if (${start} + ${openLen} <= input.length && (${openChk})) {`,
      `${ind}  ${j} = ${start} + ${openLen}`,
      `${ind}  while (${j} + ${closeLen - 1} < input.length && !(${closeChk})) ${j}++`,
      `${ind}  if (${j} + ${closeLen} <= input.length && (${closeChk})) ${endV} = ${j} + ${closeLen}`,
      `${ind}}`,
    ],
    ok: `${endV} > ${start}`,
    end: endV,
  }
}

/**
 * One trivia-loop branch for a shape, dispatched on the current char `c`
 * (= charCodeAt(_e)). Advances `_e` and `continue`s ONLY on real progress
 * (`end > _e`) — an unterminated delimited/string token leaves `end === _e`, so
 * the loop stops there exactly as the interpreter's `oneOrMore(choice(…))` would.
 */
export function scanBranch(shape: ScanShape, mint: Mint): string {
  const m = emitShapeMatch(shape, '_e', mint, '    ', 'c')
  return [...m.setup, `    if (${m.end} > _e) { _e = ${m.end}; continue }`].join('\n')
}

/**
 * A labeled branch: match one token and, on progress, log its [start, end,
 * kindIndex] trivia chunk. Same completion semantics as scanBranch.
 */
export function scanBranchLabeled(shape: ScanShape, kindIndex: number, mint: Mint): string {
  const m = emitShapeMatch(shape, '_e', mint, '    ', 'c')
  return [
    ...m.setup,
    `    if (${m.end} > _e) {`,
    `      if (_cap) {`,
    `        if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_e, ${m.end}, ${kindIndex})`,
    `        if (_ctx._cstTriviaLog !== undefined) _ctx._cstTriviaLog.push(_e, ${m.end}, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0, ${kindIndex})`,
    `      }`,
    `      _e = ${m.end}`,
    `      continue`,
    `    }`,
  ].join('\n')
}
