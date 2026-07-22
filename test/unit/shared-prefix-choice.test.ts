/**
 * `sharedPrefix` choice strategy: when EVERY arm of a non-disjoint `choice` begins
 * (under any composition of `node` / `parser` / `transform` / `label` wrappers) with
 * the SAME concrete leading literal/regex, the compiler recognizes that left factor
 * ONCE and REPLAYS it per arm instead of re-scanning it. Each arm is otherwise
 * emitted through the ordinary firstMatch machinery, so its reducer's `children[0]`,
 * spans, trivia logs, and failure `expected` set stay byte-identical.
 *
 * The interpreter runs the strategy through its firstMatch loop; the compiler emits
 * the shared-recognition form. Both are asserted here.
 */
import { choice, sequence, regex, literal, transform, not, node, parser as grammarParser, trivia, oneOrMore, compile, type Combinator, type ParseContext } from '../../src/index.ts'
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
  it('detects a two-arm choice sharing a leading regex (bare sequences)', () => {
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
      expect(p.parse('::before', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['::', 'before'], span: { start: 0, end: 8 } })
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

  it('recognizes the shared prefix ONLY once for the grouped arms', () => {
    // A distinctive 2-char literal prefix ("@x" → char codes 64, 120) inlines to a
    // charCodeAt check. Un-factored (firstMatch) each arm would emit its own check
    // → two `!== 120` comparisons; the left-factored form recognizes it once.
    const g = choice(
      sequence(literal('@x'), literal('foo')),
      sequence(literal('@x'), literal('bar')),
    )
    expect(strategyOf(g)).toBe('sharedPrefix')
    const src = compile(g).source
    expect((src.match(/!== 120/g) ?? []).length).toBe(1)

    for (const p of both(g)) {
      expect(p.parse('@xfoo', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['@x', 'foo'] })
      expect(p.parse('@xbar', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['@x', 'bar'] })
      expect(p.parse('@xzz', 0, { trackLines: false }).ok).toBe(false)
      expect(p.parse('zz', 0, { trackLines: false }).ok).toBe(false)
    }
  })

  it('backtracks a partially-matched arm to a later arm without leaking', () => {
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

  // The motivating real shape: `DirectLessStaticPseudo`-style arms —
  // `node('Type', parser({ trivia }, sequence(regex(/::?/), …)), reducer)`.
  it('fires for wrapped node(parser(sequence(...))) arms and keeps reducer children[0] byte-identical', () => {
    const ws = trivia(oneOrMore(literal(' ')))
    const cst = (type: string) =>
      (children: readonly unknown[], _f: unknown, span: { start: number; end: number }) =>
        ({ type, span, children: [...children] })
    const g = choice(
      node('Func', grammarParser({ trivia: ws }, sequence(regex(/::?/), regex(/[a-z]+/), literal('('), regex(/[a-z]+/), literal(')'))), cst('Func')),
      node('Simple', grammarParser({ trivia: ws }, sequence(regex(/::?/), not(literal('!')), regex(/[a-z]+/))), cst('Simple')),
    )
    expect(strategyOf(g)).toBe('sharedPrefix')

    // The `::?` scan (a charCodeAt do/while loop) is emitted exactly once — the arms
    // replay it rather than re-scanning.
    const src = compile(g).source
    expect((src.match(/do \{/g) ?? []).length).toBe(1)

    const ctx = () => ({ trackLines: false, trivia: ws, captureTrivia: true }) as unknown as Record<string, unknown>
    for (const p of both(g)) {
      const arm1 = p.parse('::foo(bar)', 0, ctx())
      expect(arm1).toMatchObject({ ok: true, value: { type: 'Func' } })
      // The shared prefix leaf is byte-identical to the un-factored parse.
      expect((arm1.value as { children: unknown[] }).children[0]).toEqual({ _tag: 'leaf', value: '::', span: { start: 0, end: 2 } })

      const arm2 = p.parse(':hover', 0, ctx())
      expect(arm2).toMatchObject({ ok: true, value: { type: 'Simple' } })
      expect((arm2.value as { children: unknown[] }).children[0]).toEqual({ _tag: 'leaf', value: ':', span: { start: 0, end: 1 } })

      // neither
      expect(p.parse('zz', 0, ctx()).ok).toBe(false)
      expect(p.parse('::', 0, ctx()).ok).toBe(false)
    }
  })

  it('fires for a transform-wrapped arm (value shape preserved by full-arm emission)', () => {
    const g = choice(
      transform(sequence(literal('--'), literal('a')), v => v),
      sequence(literal('--'), literal('b')),
    )
    expect(strategyOf(g)).toBe('sharedPrefix')
    for (const p of both(g)) {
      expect(p.parse('--a', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['--', 'a'] })
      expect(p.parse('--b', 0, { trackLines: false })).toMatchObject({ ok: true, value: ['--', 'b'] })
      expect(p.parse('--c', 0, { trackLines: false }).ok).toBe(false)
    }
  })

  it('conservatively skips shapes it cannot prove byte-identical', () => {
    // A non-sequence arm → not a wrapped-or-bare sequence.
    expect(strategyOf(choice(
      sequence(literal('--'), literal('a')),
      literal('--b'),
    ))).not.toBe('sharedPrefix')

    // Arms with DIFFERENT leading terms → no shared factor.
    expect(strategyOf(choice(
      sequence(literal('--'), literal('a')),
      sequence(literal('++'), literal('b')),
    ))).not.toBe('sharedPrefix')

    // Differently-SPELLED-but-equivalent prefixes are NOT unified (deliberate,
    // documented limitation): `regex(/::?/)` vs `choice(':', '::')` do not group.
    expect(strategyOf(choice(
      sequence(regex(/::?/), literal('a')),
      sequence(choice(literal('::'), literal(':')), literal('b')),
    ))).not.toBe('sharedPrefix')
  })
})
