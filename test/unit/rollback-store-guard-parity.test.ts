/**
 * Rollback truncations must be GUARDED on a changed length — in BOTH engines.
 *
 * Assigning `array.length` is not a plain field store: it runs V8's length
 * setter, which must decide whether to trim the backing store, and it costs the
 * same whether or not the value changes. A speculative branch that captured
 * NOTHING still paid for every store, and that is the common case. This is not a
 * micro-detail: 0.34.0's `not()` rollback (correct, and required) put six
 * unconditional stores on a probe that jess's Less grammar executes ~600 times
 * per KB, costing +32% parse time on `benchmark.less`. Guarding the stores
 * everywhere made the corrected build FASTER than the one before the fix.
 *
 * The two engines have drifted on exactly this kind of change before — the
 * `not()` trivia leak was invisible because interpreted and compiled were wrong
 * IDENTICALLY, so behavioural parity never flagged it. A test that only asserts
 * the parsed VALUE cannot see a redundant store at all. So this test checks each
 * engine at the place the guard actually lives:
 *   - the INTERPRETER's shared rollback helpers, driven directly with sinks that
 *     count `length =` writes
 *   - the COMPILED engine's emitted source, which must contain no bare store
 *
 * If one engine loses the guard, only that engine's test fails, and the failure
 * names it.
 */
import { describe, it, expect } from 'vitest'
import {
  node, regex, literal, sequence, many, optional, choice, not, attempt, compile,
} from '../../src/index.ts'
import { saveCstMark, rollbackCstCapture } from '../../src/cst/capture-buffer.ts'
import { saveTriviaMark, rollbackTrivia } from '../../src/combinators/trivia-skip.ts'
import type { ParseContext } from '../../src/types.ts'

/**
 * A sink that counts `length =` writes, splitting redundant from real.
 *
 * NOT an `extends Array` subclass: an array's `length` is an OWN data property
 * of the instance, so a `length` accessor declared on a subclass PROTOTYPE is
 * shadowed and never runs — a counter written that way silently reads zero for
 * everything and the test passes vacuously. This wraps an array instead.
 */
class CountingSink {
  redundant = 0
  real = 0
  private items: unknown[] = []
  get length(): number { return this.items.length }
  set length(next: number) {
    if (next === this.items.length) this.redundant++
    else this.real++
    this.items.length = next
  }
  push(...values: unknown[]): number { return this.items.push(...values) }
}

function sinks() {
  const leaves = new CountingSink()
  const raw = new CountingSink()
  const cstTriviaLog = new CountingSink()
  const triviaLog = new CountingSink()
  const fields = new CountingSink()
  const errors = new CountingSink()
  const all = [leaves, raw, cstTriviaLog, triviaLog, fields, errors]
  const ctx = {
    trackLines: false,
    _cstLeaves: leaves,
    _cstRawChildren: raw,
    _cstTriviaLog: cstTriviaLog,
    _triviaLog: triviaLog,
    _fields: fields,
    _errors: errors,
  } as unknown as ParseContext
  return {
    ctx,
    all,
    triviaLog,
    redundant: () => all.reduce((n, a) => n + a.redundant, 0),
    real: () => all.reduce((n, a) => n + a.real, 0),
  }
}

describe('interpreter: rollback helpers never rewrite a length they already had', () => {
  it('rollbackCstCapture to an UNCHANGED mark writes nothing', () => {
    const s = sinks()
    for (const a of s.all) a.push(1, 2, 3)
    const mark = saveCstMark(s.ctx)
    rollbackCstCapture(s.ctx, mark)     // nothing was captured in between
    expect({ redundant: s.redundant(), real: s.real() })
      .toEqual({ redundant: 0, real: 0 })
    for (const a of s.all) expect(a.length).toBe(3)
  })

  it('rollbackCstCapture still truncates for real when something WAS captured', () => {
    const s = sinks()
    for (const a of s.all) a.push(1)
    const mark = saveCstMark(s.ctx)
    for (const a of s.all) a.push(2, 3)
    rollbackCstCapture(s.ctx, mark)
    expect(s.redundant()).toBe(0)
    expect(s.real()).toBeGreaterThan(0)
    // The guard skipped nothing REAL. `_triviaLog` is deliberately not a
    // rollbackCstCapture sink — only rollbackTrivia rewinds it — so it keeps
    // everything, which is exactly the pre-existing behaviour this must preserve.
    for (const a of s.all) expect(a.length).toBe(a === s.triviaLog ? 3 : 1)
  })

  // The BUFFERED node-capture path (`_cstBuf.ch` / `_cstBuf.raw`, via
  // rollbackBufList) is a separate branch of rollbackCstCapture that the flat
  // cases above never reach — `rollbackCstCapture` returns early when `_cstBuf`
  // is set. It is also interpreter-ONLY: the compiled engine inlines its own
  // capture and never calls here, so no source assertion can cover it and
  // nothing else in this file would notice it losing the guard.
  it('the buffered node-capture lists do not rewrite a length they already had', () => {
    const ch = new CountingSink()
    const raw = new CountingSink()
    ch.push(1, 2, 3)
    raw.push(1, 2, 3)
    const ctx = { trackLines: false, _cstBuf: { ch, raw } } as unknown as ParseContext
    const mark = saveCstMark(ctx)
    rollbackCstCapture(ctx, mark)
    expect({ chRedundant: ch.redundant, rawRedundant: raw.redundant }).toEqual({ chRedundant: 0, rawRedundant: 0 })
    expect(ch.length).toBe(3)
    expect(raw.length).toBe(3)
  })

  it('the buffered node-capture lists still truncate for real', () => {
    const ch = new CountingSink()
    const raw = new CountingSink()
    ch.push(1, 2)
    raw.push(1, 2)
    const ctx = { trackLines: false, _cstBuf: { ch, raw } } as unknown as ParseContext
    const mark = saveCstMark(ctx)          // marks at 2 — above the single-slot branches
    ch.push(3, 4)
    raw.push(3, 4)
    rollbackCstCapture(ctx, mark)
    expect({ chRedundant: ch.redundant, rawRedundant: raw.redundant }).toEqual({ chRedundant: 0, rawRedundant: 0 })
    expect({ ch: ch.real, raw: raw.real }).toEqual({ ch: 1, raw: 1 })
    expect(ch.length).toBe(2)
    expect(raw.length).toBe(2)
  })

  it('rollbackTrivia to an UNCHANGED mark writes nothing, and still rewinds a real one', () => {
    const s = sinks()
    for (const a of s.all) a.push(1)
    const noop = saveTriviaMark(s.ctx)
    rollbackTrivia(s.ctx, noop)
    expect({ redundant: s.redundant(), real: s.real() }).toEqual({ redundant: 0, real: 0 })

    const mark = saveTriviaMark(s.ctx)
    for (const a of s.all) a.push(2)
    rollbackTrivia(s.ctx, mark)
    expect(s.redundant()).toBe(0)
    expect(s.real()).toBeGreaterThan(0)
    for (const a of s.all) expect(a.length).toBe(1)
  })
})

// A grammar that forces every rollback path to be EMITTED: `not()` probes
// (the 0.34.0 regression site) including the nested `not(not(...))` shape jess's
// Less grammar actually contains, a failing `attempt` arm inside a non-disjoint
// `choice`, and `many`/`optional` iterations that fail after consuming.
const word = regex(/[a-z]+/)
const num = regex(/[0-9]+/)
const grp = sequence(literal('['), word, literal(']'))

const doc = node(
  'Doc',
  many(
    choice(
      attempt(sequence(grp, literal('!'))),
      attempt(grp),
      sequence(not(num), word),
      sequence(not(not(word)), word, optional(grp)),
      literal(' '),
    ),
    { min: 0 },
  ),
  children => children.length,
)

const INPUT = '[a] [bb]! ccc [d] eee [f]! ggg [hh] iii '.repeat(20)

describe('compiled: emitted rollbacks carry the guard', () => {
  const source = compile(doc).source

  it('emits at least one rollback (the fixture really exercises them)', () => {
    expect(/_ctx\._cstLeaves\.length = /.test(source)).toBe(true)
  })

  it('emits NO bare length store — every one is preceded by a !== compare', () => {
    const bare: string[] = []
    const re = /_ctx\.(_cstLeaves|_cstRawChildren|_cstTriviaLog|_triviaLog|_fields|_errors|_cstChildren)\.length = ([A-Za-z0-9_]+)/g
    for (const m of source.matchAll(re)) {
      const before = source.slice(Math.max(0, m.index - 160), m.index)
      const guarded = new RegExp(`_ctx\\.${m[1]} && _ctx\\.${m[1]}\\.length !== ${m[2]}\\)\\s*$`).test(before)
      if (!guarded) bare.push(source.slice(Math.max(0, m.index - 60), m.index + m[0].length))
    }
    expect(bare).toEqual([])
  })
})

describe('both engines still agree on the parsed value', () => {
  it('interpreted and compiled produce the same result', () => {
    const interpreted = doc.parse(INPUT, 0, { trackLines: false } as ParseContext)
    const compiled = compile(doc).parse(INPUT)
    expect(compiled.ok).toBe(interpreted.ok)
    expect(compiled.ok && interpreted.ok && compiled.value).toEqual(interpreted.ok && interpreted.value)
  })
})
