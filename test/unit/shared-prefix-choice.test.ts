/**
 * `sharedPrefix` choice strategy: when EVERY arm is a bare `sequence(...)` that
 * begins with the SAME concrete leading literal/regex, the compiler left-factors
 * that prefix and parses it ONCE, then tries each arm's residual terms in PEG
 * order from the shared end position — instead of re-parsing the prefix per arm.
 *
 * The strategy must be a faithful specialization of `firstMatch`: identical value,
 * span, CST capture, and failure `expected` in BOTH the interpreter and compiled
 * output. The interpreter runs it through the firstMatch loop; the compiler emits
 * the single-parse form. Both are asserted here.
 */
import { choice, sequence, regex, literal, transform, compile, type Combinator, type ParseContext } from '../../src/index.ts'
import { describe, expect, it } from 'vitest'

type Runner = { parse(input: string, pos: number, ctx: Record<string, unknown>): { ok: boolean; value?: unknown; span: { start: number; end: number }; expected?: string[] } }

/** Interpreter and compiled runners for the same grammar (both-mode parity). */
function both(parser: Combinator<unknown>): Runner[] {
  const compiled = compile(parser)
  return [
    { parse: (input, pos, ctx) => parser.parse(input, pos, ctx as ParseContext) },
    { parse: (input, pos, ctx) => compiled.parseWithContext(input, ctx as ParseContext, pos) },
  ]
}

const strategyOf = (p: Combinator<unknown>): string =>
  (p._def as { tag: string; strategy?: { tag: string } }).strategy?.tag ?? '(none)'

describe('choice — sharedPrefix strategy', () => {
  it('detects a two-arm choice sharing a leading regex', () => {
    const g = choice(
      sequence(regex(/::?/), literal('before')),
      sequence(regex(/::?/), literal('hover')),
    )
    expect(strategyOf(g)).toBe('sharedPrefix')
    expect((g._def as { strategy: { members: number[] } }).strategy.members).toEqual([0, 1])
  })

  it('parses arm 1, arm 2, and neither — identically in interpreter and compiled', () => {
    const g = choice(
      sequence(regex(/::?/), literal('before')),
      sequence(regex(/::?/), literal('hover')),
    )
    for (const p of both(g)) {
      // arm 1 (double-colon and single-colon both match the shared `::?` prefix)
      expect(p.parse('::before', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['::', 'before'], span: { start: 0, end: 8 } })
      // arm 2
      expect(p.parse(':hover', 0, { trackLines: false })).toMatchObject({ ok: true, value: [':', 'hover'], span: { start: 0, end: 6 } })
      // prefix matches but no residual does → failure reports both residuals' expected
      const missResidual = p.parse('::nope', 0, { trackLines: false })
      expect(missResidual.ok).toBe(false)
      expect(missResidual.expected).toEqual(['"before"', '"hover"'])
      // prefix itself fails → failure reports the prefix expected once PER arm
      // (byte-identical to the un-factored firstMatch `[...slot0, ...slot1]` concat)
      const missPrefix = p.parse('xyz', 0, { trackLines: false })
      expect(missPrefix.ok).toBe(false)
      expect(missPrefix.expected).toEqual(['/::?/', '/::?/'])
    }
  })

  it('emits the shared prefix-matching construct ONLY once for the grouped arms', () => {
    // A distinctive 2-char literal prefix ("@x" → char codes 64, 120) inlines to a
    // charCodeAt check. Un-factored (firstMatch) each arm would emit its own check
    // → two `!== 120` comparisons; the left-factored form emits exactly one.
    const g = choice(
      sequence(literal('@x'), literal('foo')),
      sequence(literal('@x'), literal('bar')),
    )
    expect(strategyOf(g)).toBe('sharedPrefix')
    const src = compile(g).source
    expect((src.match(/!== 120/g) ?? []).length).toBe(1)

    // …and it still parses correctly in both modes.
    for (const p of both(g)) {
      expect(p.parse('@xfoo', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['@x', 'foo'] })
      expect(p.parse('@xbar', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['@x', 'bar'] })
      expect(p.parse('@xzz', 0, { trackLines: false }).ok).toBe(false)
      expect(p.parse('zz', 0, { trackLines: false }).ok).toBe(false)
    }
  })

  it('backtracks a partially-matched residual to a later arm without leaking', () => {
    // '::aaY': arm 1 matches the prefix + "aa" then fails on "X" — the residual must
    // roll back and arm 2 win, with the shared prefix kept parsed once.
    const g = choice(
      sequence(regex(/::?/), literal('aa'), literal('X')),
      sequence(regex(/::?/), literal('aa'), literal('Y')),
    )
    expect(strategyOf(g)).toBe('sharedPrefix')
    for (const p of both(g)) {
      expect(p.parse('::aaX', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['::', 'aa', 'X'] })
      expect(p.parse('::aaY', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['::', 'aa', 'Y'] })
      const miss = p.parse('::aaZ', 0, { trackLines: false })
      expect(miss.ok).toBe(false)
      expect(miss.expected).toEqual(['"X"', '"Y"'])
    }
  })

  it('conservatively skips shapes it cannot prove byte-identical', () => {
    // A non-sequence arm → not a pure single-group shared prefix.
    expect(strategyOf(choice(
      sequence(literal('--'), literal('a')),
      literal('--b'),
    ))).not.toBe('sharedPrefix')

    // Arms with DIFFERENT leading terms → no shared factor.
    expect(strategyOf(choice(
      sequence(literal('--'), literal('a')),
      sequence(literal('++'), literal('b')),
    ))).not.toBe('sharedPrefix')

    // A transform-wrapped arm changes the value/capture shape → left-factoring it
    // would not be byte-identical, so the detector must skip the whole choice.
    expect(strategyOf(choice(
      transform(sequence(literal('--'), literal('a')), v => v),
      sequence(literal('--'), literal('b')),
    ))).not.toBe('sharedPrefix')
  })
})
