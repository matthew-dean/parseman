/**
 * Gated choice arms — per-arm predicates checked before attempting the arm.
 * Mirrors Chevrotain's GATE: behaviour.
 */
import { describe, it, expect } from 'vitest'
import { literal, sequence, choice, many, parse, compile } from '../../src/index.ts'
import { guard, withCtx } from '../../src/index.ts'
import type { GatedArm } from '../../src/index.ts'

type Ctx = { inFn: boolean }

describe('gated choice arms — runtime', () => {
  it('ungated arm always attempted', () => {
    const p = choice(literal('x'), literal('y'))
    expect(parse(p, 'x').ok).toBe(true)
    expect(parse(p, 'y').ok).toBe(true)
  })

  it('gated arm skipped when gate false', () => {
    // returnKw only accessible when inFn is true
    const p = choice(
      { gate: (u) => (u as Ctx | undefined)?.inFn === true, parser: literal('return') } satisfies GatedArm,
      literal('ident'),
    )
    // No user context → gate false → returnKw skipped → ident matches
    const r = parse(p, 'ident')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('ident')
  })

  it('gated arm attempted when gate true', () => {
    const p = choice(
      { gate: (u) => (u as Ctx | undefined)?.inFn === true, parser: literal('return') } satisfies GatedArm,
      literal('ident'),
    )
    const inner = withCtx<Ctx, unknown>({ inFn: true }, p)
    const r = parse(inner, 'return')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('return')
  })

  it('gate false causes next arm to be tried', () => {
    // gate always false → first arm always skipped → second arm wins
    const p = choice(
      { gate: () => false, parser: literal('never') } satisfies GatedArm,
      literal('yes'),
    )
    const r = parse(p, 'yes')
    expect(r.ok).toBe(true)
  })

  it('multiple gated arms: first matching gate wins', () => {
    type S = { mode: 'a' | 'b' | 'c' }
    const p = choice(
      { gate: (u) => (u as S | undefined)?.mode === 'a', parser: literal('alpha') } satisfies GatedArm<string>,
      { gate: (u) => (u as S | undefined)?.mode === 'b', parser: literal('beta') }  satisfies GatedArm<string>,
      literal('fallback'),
    )

    const inA = withCtx<S, unknown>({ mode: 'a' }, p)
    const inB = withCtx<S, unknown>({ mode: 'b' }, p)

    const ra = parse(inA, 'alpha')
    expect(ra.ok && ra.value).toBe('alpha')

    const rb = parse(inB, 'beta')
    expect(rb.ok && rb.value).toBe('beta')

    // neither gate passes → fallback
    const rc = parse(p, 'fallback')
    expect(rc.ok && rc.value).toBe('fallback')
  })

  it('gated choice: fails when all gates block the only matching arm', () => {
    const p = choice(
      { gate: () => false, parser: literal('x') } satisfies GatedArm,
    )
    expect(parse(p, 'x').ok).toBe(false)
  })

  it('practical: return keyword only inside function context', () => {
    type S = { inFn: boolean }
    const stmt = choice(
      { gate: (u) => (u as S | undefined)?.inFn === true, parser: literal('return') } satisfies GatedArm,
      literal('expr'),
    )
    const fnBody = withCtx<S, unknown>({ inFn: true }, many(sequence(stmt, literal(';'))))

    // inside fn body: return parses
    const r1 = parse(fnBody, 'return;expr;return;')
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.value[0]![0]).toBe('return')
      expect(r1.value[1]![0]).toBe('expr')
      expect(r1.value[2]![0]).toBe('return')
    }

    // outside fn body: 'return' can't be parsed — no context → gate fails → 'return' ≠ 'expr'
    const r2 = parse(many(sequence(stmt, literal(';'))), 'return;')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.value.length).toBe(0)   // 'return;' doesn't match 'expr;'
  })
})

describe('gated choice arms — compiled', () => {
  it('gate false skips arm in compiled parser', () => {
    const p = compile(choice(
      { gate: () => false, parser: literal('never') } satisfies GatedArm,
      literal('yes'),
    ))
    const r = p.parse('yes')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('yes')
  })

  it('gate with withCtx in compiled parser', () => {
    type S = { on: boolean }
    const inner = choice(
      { gate: (u) => (u as S).on, parser: literal('on') } satisfies GatedArm<string>,
      literal('off'),
    )
    const p = compile(withCtx<S, unknown>({ on: true }, inner))
    const r = p.parse('on')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('on')
  })
})
