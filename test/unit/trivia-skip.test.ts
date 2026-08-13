import { describe, it, expect } from 'vitest'
import { advanceTrivia, commitTriviaScan, consumeTrivia, scanTrivia, triviaScanEnd } from '../../src/combinators/trivia-skip.ts'
import { trivia, label, regex, oneOrMore, choice, sequence, literal } from '../../src/index.ts'

const labeledRw = trivia(oneOrMore(choice(
  label('whitespace', regex(/[ \t]+/)),
  label('lineComment', regex(/\/\/.*/)),
)))

describe('advanceTrivia()', () => {
  it('uses labeled scan when ctx.triviaKindLabels is set', () => {
    const ctx = {
      trackLines: false,
      trivia: labeledRw,
      triviaKindLabels: ['whitespace', 'lineComment'],
    }
    expect(advanceTrivia('  x', 0, ctx)).toBe(2)
    expect(advanceTrivia('//cmt\nx', 0, ctx)).toBe(5)
  })

  it('returns the position unchanged when ctx has no trivia parser', () => {
    expect(advanceTrivia('  x', 0, { trackLines: false })).toBe(0)
  })

  it('skips via a plain (unlabeled) trivia parser', () => {
    const ctx = { trackLines: false, trivia: regex(/[ \t]+/) }
    expect(advanceTrivia('   y', 0, ctx)).toBe(3)
    // No trivia at the cursor → position unchanged.
    expect(advanceTrivia('y', 0, ctx)).toBe(0)
  })

  it('fast-skips a structurally scannable character run without regex exec', () => {
    // The acceleration is based only on the proven char-run structure. It does
    // not reserve any punctuation or category name for a particular language.
    const rw = trivia(regex(/[ \t\n\r\f]+/))
    expect(advanceTrivia('', 0, { trackLines: false, trivia: rw })).toBe(0)
    const exec = RegExp.prototype.exec
    let calls = 0
    RegExp.prototype.exec = function patchedExec(input: string) {
      calls++
      return exec.call(this, input)
    }
    try {
      expect(advanceTrivia('  \t\r\ny', 0, { trackLines: false, trivia: rw })).toBe(5)
      expect(calls).toBe(0)
    } finally {
      RegExp.prototype.exec = exec
    }
  })

  it('tracks lines through the generic trivia fallback', () => {
    const lineIndex = { lineStarts: [0] }
    const ctx = {
      trackLines: true,
      trivia: sequence(literal('x'), regex(/\n+/)),
      _lineIndex: lineIndex,
      _lineScannedTo: 0,
    }
    expect(advanceTrivia('x\n\nz', 0, ctx)).toBe(3)
    expect(ctx._lineScannedTo).toBe(3)
    expect(lineIndex.lineStarts).toEqual([0, 2, 3])
  })
})

describe('scanTrivia()', () => {
  it('returns a no-op scan when ctx has no trivia parser', () => {
    const scan = scanTrivia('  x', 0, { trackLines: false })
    expect(triviaScanEnd(scan)).toBe(0)
    expect(() => commitTriviaScan(scan)).not.toThrow()
  })

  it('tracks lines and commits logs through the generic fallback', () => {
    const lineIndex = { lineStarts: [0] }
    const log: number[] = []
    const ctx = {
      trackLines: true,
      trivia: sequence(literal('x'), regex(/\n+/)),
      _lineIndex: lineIndex,
      _lineScannedTo: 0,
      _triviaLog: log,
    }
    const scan = scanTrivia('x\nz', 0, ctx)
    expect(triviaScanEnd(scan)).toBe(2)
    expect(ctx._lineScannedTo).toBe(2)
    expect(lineIndex.lineStarts).toEqual([0, 2])
    commitTriviaScan(scan)
    expect(log).toEqual([0, 2])
  })
})

describe('consumeTrivia() — non-deferred', () => {
  it('advances directly when no trivia recording is active', () => {
    const ctx = { trackLines: false, trivia: regex(/[ \t]+/) }
    expect(consumeTrivia('   z', 0, ctx)).toBe(3)
  })
})

describe('consumeTrivia()', () => {
  it('commits deferred trivia into _triviaLog when recording is active', () => {
    const log: number[] = []
    const ctx = { trackLines: false, trivia: regex(/[ \t]+/), _triviaLog: log }
    const end = consumeTrivia('  hi', 0, ctx)
    expect(end).toBe(2)
    expect(log).toEqual([0, 2])
  })
})

// The alternation-star fast scanner `(?:[class]|#[^\n\r]*)*` (GraphQL-style ws +
// line-comment trivia). These branches — the fused scanner's comment-to-EOL
// consume, and the ordered fallback when a marker also sits inside a class —
// were previously exercised only by an uncommitted dev-time differential.
describe('advanceTrivia() — alternation-star scanner (line comments)', () => {
  // `#` is disjoint from the ws class → one fused merged-range scanner whose
  // comment arm consumes to the next newline.
  const wsHash = trivia(regex(/(?:[ \t\n\r]|#[^\n\r]*)*/))

  it('skips whitespace and #-line-comments on the fast path (no regex exec)', () => {
    // Warm the scanner cache first — building it classifies arms via RegExp.exec.
    advanceTrivia('', 0, { trackLines: false, trivia: wsHash })
    const exec = RegExp.prototype.exec
    let calls = 0
    RegExp.prototype.exec = function patchedExec(this: RegExp, s: string) { calls++; return exec.call(this, s) }
    try {
      expect(advanceTrivia('#c1\n  #c2\n x', 0, { trackLines: false, trivia: wsHash })).toBe(11)
      expect(advanceTrivia('  # to the end', 0, { trackLines: false, trivia: wsHash })).toBe(14) // comment runs to EOF
      expect(calls).toBe(0) // proves the fused scanner ran, not RegExp.exec
    } finally {
      RegExp.prototype.exec = exec
    }
  })

  it('matches native RegExp across mixed ws/comment inputs', () => {
    const re = /^(?:[ \t\n\r]|#[^\n\r]*)*/
    for (const s of ['', ' ', '#x', '#x\ny', ' #a\n#b\n z', '#no newline', '\n\n#c', 'x', '# a b c']) {
      const want = (s.match(re) as RegExpMatchArray)[0].length
      expect(advanceTrivia(s, 0, { trackLines: false, trivia: wsHash }), s).toBe(want)
    }
  })
})

describe('advanceTrivia() — marker-inside-a-class overlap uses ordered arms', () => {
  // `#` is BOTH in the class `[ #]` AND the comment marker. Arm order is then
  // load-bearing: the class arm is first, so `#` is a single trivia char, NOT a
  // comment start. A fused scan would wrongly eat the rest of the line, so this
  // must fall back to the ordered loopScanner.
  const overlap = trivia(regex(/(?:[ #]|#[^\n\r]*)*/))

  it('treats `#` per arm order (ordered fallback), matching RegExp', () => {
    const re = /^(?:[ #]|#[^\n\r]*)*/
    for (const s of ['#abc', '# #', '  ## x', '#', 'ab', ' # \n', '###z']) {
      const want = (s.match(re) as RegExpMatchArray)[0].length
      expect(advanceTrivia(s, 0, { trackLines: false, trivia: overlap }), s).toBe(want)
    }
    // Concretely: only the leading `#` is trivia (class char); `abc` stops it.
    expect(advanceTrivia('#abc', 0, { trackLines: false, trivia: overlap })).toBe(1)
  })
})
