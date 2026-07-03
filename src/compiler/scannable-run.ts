/**
 * Structural recognition of "scannable" parser arms — regex shapes that lower to
 * a tight character-scan loop instead of `regex.exec` / combinator dispatch. Each
 * shape is derived from the regex STRUCTURE, not from any hardcoded knowledge
 * that a given regex "is whitespace" or "is a comment":
 *
 *   [X]+ / [X]*            → run while the char ∈ X                (chars)
 *   <lit>[^X]*             → consume <lit>, run until char ∈ X     (until)
 *   <open>(?:…)*<close>    → consume <open>, run to <close> literal (delimited)
 *
 * A `oneOrMore(choice(a, b, …))` where every arm is one of these compiles to a
 * single char-dispatch loop with one branch per arm — any count/order, because
 * the shapes dispatch on their first 1–2 chars and are checked in turn. Trivia
 * (whitespace + comments) is just the value-discarded instance of this; nothing
 * here is trivia-specific.
 */

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

/** Backslash (`\`) code point — the escape lead char in string shapes. */
export const BACKSLASH = 92

const CLASS_ESCAPES: Record<string, number> = { t: 9, n: 10, r: 13, f: 12, v: 11, '0': 0 }
const META = new Set('()[]{}*+?|^$.'.split(''))

/**
 * ASCII code-point ranges for the shorthand classes we can lower safely. `\d`
 * and `\w` are ASCII-only in the default (non-`u`) engine, so they map to fixed
 * ranges. `\s` is deliberately absent — it includes Unicode whitespace
 * (`\u00a0`, `\u1680`, …) that a fixed ASCII range would silently drop.
 */
function shorthandRanges(ch: 'd' | 'w'): Array<[number, number]> {
  return ch === 'd'
    ? [[48, 57]]
    : [[48, 57], [65, 90], [97, 122], [95, 95]]
}

type ClassAtom = { cp: number } | { set: Array<[number, number]> }

/**
 * Parse a regex char-class body (chars between `[` and `]`) to code-point ranges.
 * `\d`/`\w` expand to their ASCII ranges; other letter escapes (`\s`, `\D`,
 * `\W`, `\S`, `\b`, …) return null rather than being mis-read as literal letters.
 */
function parseClassRanges(body: string): Array<[number, number]> | null {
  const ranges: Array<[number, number]> = []
  let i = 0
  const readAtom = (): ClassAtom | null => {
    const ch = body[i]
    if (ch === undefined) return null
    if (ch === '\\') {
      const e = body[i + 1]
      if (e === undefined) return null
      i += 2
      if (e in CLASS_ESCAPES) return { cp: CLASS_ESCAPES[e]! }
      if (e === 'd' || e === 'w') return { set: shorthandRanges(e) }
      // Any other letter escape is a class we can't safely lower (\s, \D, …).
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
  const body = cls.slice(1, -1)
  if (body.startsWith('^')) return null
  return parseClassRanges(body)
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
 * Recognize one scannable arm from its regex source, or null if it isn't one of
 * the structural shapes. Order matters: char-class run, ident, string, then
 * open-until-terminator, then delimited.
 */
export function parseScanShape(source: string): ScanShape | null {
  // [X]+ / [X]* — a positive char-class run (a leading `^` negation is not one).
  let m = /^\[((?:\\.|[^\]])+)\]([+*])$/.exec(source)
  if (m) {
    if (m[1]!.startsWith('^')) return null
    const ranges = parseClassRanges(m[1]!)
    return ranges ? { kind: 'chars', ranges, minOne: m[2] === '+' } : null
  }
  // \d+ / \w+ / \d* / \w* — a bare shorthand-class run.
  m = /^\\([dw])([+*])$/.exec(source)
  if (m) {
    return { kind: 'chars', ranges: shorthandRanges(m[1] as 'd' | 'w'), minOne: m[2] === '+' }
  }
  // <head><tail>* — identifier run: one head char, then a run of tail chars.
  // Each of head/tail is a `[...]` class or a `\d`/`\w` shorthand.
  m = /^(\[(?:\\.|[^\]])+\]|\\[dw])(\[(?:\\.|[^\]])+\]|\\[dw])\*$/.exec(source)
  if (m) {
    const head = classToRanges(m[1]!)
    const tail = classToRanges(m[2]!)
    return head && tail ? { kind: 'ident', head, tail } : null
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
    return null
  }
  // <open>(?:…)*<close> — delimited token scanned to its first close literal.
  // Reject escape-aware bodies (a literal `\\` in the source ⇒ string-like), where
  // "scan to first close" would wrongly stop at an escaped delimiter.
  if (!source.includes('\\\\')) {
    m = /^(.*?)\((?:\?:)?[\s\S]*\)\*(.*?)$/.exec(source)
    if (m && m[1] && m[2]) {
      const open = literalCodePoints(m[1])
      const close = literalCodePoints(m[2])
      if (open && close) return { kind: 'delimited', open, close }
    }
  }
  return null
}

/**
 * Flag-aware wrapper around `parseScanShape`. Lowering to a raw code-point scan
 * assumes default regex semantics, so any flag that changes matching (`i` case
 * folding, `u` surrogate handling, `m`/`s` anchor/dot behavior) disables it.
 * `g`/`y` are stickiness-only and safe.
 */
export function scanShapeFromRegex(source: string, flags: string): ScanShape | null {
  if (/[imsu]/.test(flags)) return null
  return parseScanShape(source)
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

export function emitShapeMatch(
  shape: ScanShape,
  start: string,
  mint: Mint,
  ind: string,
  firstChar?: string,
): ShapeMatch {
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
