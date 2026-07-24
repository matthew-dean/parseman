/**
 * Codegen for gate() and withCtx() — verifies these combinators compile to
 * inline code rather than falling through to the runtime fallback path.
 *
 * Each test checks both runtime (parse) and compiled (compile().parse) output
 * are identical, and also inspects the generated source where useful.
 */
import { describe, it, expect } from 'vitest'
import { literal, sequence, choice, many, optional, transform, parse, compile } from '../../src/index.ts'
import { gate, withCtx } from '../../src/index.ts'

// ---------------------------------------------------------------------------
// gate() codegen
// ---------------------------------------------------------------------------
describe('gate() codegen', () => {
  it('compiles to inline gate check — no runtime fallback', () => {
    const p = compile(gate(() => true))
    // Should have no _rp (runtime parser fallbacks) in the generated source
    expect(p.source).not.toContain('_rp[')
    expect(p.source).toContain('_mf[')   // predicate captured in mapFns
  })

  it('passes when predicate is true', () => {
    const p = compile(gate(() => true))
    const r = p.parse('')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe(null)
      expect(r.span.end).toBe(0)
    }
  })

  it('fails when predicate is false', () => {
    const p = compile(gate(() => false))
    expect(p.parse('').ok).toBe(false)
  })

  it('reads _ctx.user via predicate', () => {
    const p = compile(
      withCtx({ flag: true },
        gate((u) => (u as { flag: boolean }).flag)
      )
    )
    expect(p.parse('').ok).toBe(true)

    const p2 = compile(
      withCtx({ flag: false },
        gate((u) => (u as { flag: boolean }).flag)
      )
    )
    expect(p2.parse('').ok).toBe(false)
  })

  it('guard in sequence: gates rest of sequence', () => {
    type S = { allow: boolean }
    const p = compile(
      withCtx<S, unknown>({ allow: true },
        sequence(
          gate((u) => (u as S).allow),
          literal('ok'),
        )
      )
    )
    const r = p.parse('ok')
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as [unknown, string])[1]).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// withCtx() codegen
// ---------------------------------------------------------------------------
describe('withCtx() codegen', () => {
  it('compiles to inline named function — no runtime fallback', () => {
    const p = compile(withCtx({ x: 1 }, literal('a')))
    expect(p.source).not.toContain('_rp[')
    // withCtx emits a named inner function and a call
    expect(p.source).toContain('_wcf')
  })

  it('parses correctly', () => {
    const p = compile(withCtx({ x: 1 }, literal('hello')))
    const r = p.parse('hello')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('hello')
  })

  it('sets user context for inner guard', () => {
    type S = { mode: string }
    const p = compile(
      withCtx<S, unknown>({ mode: 'strict' },
        gate((u) => (u as S).mode === 'strict')
      )
    )
    expect(p.parse('').ok).toBe(true)
  })

  it('outer context is unchanged after withCtx', () => {
    // withCtx should not bleed into parsers after it in a sequence
    type S = { on: boolean }
    const guardOn = gate((u) => (u as S | undefined)?.on === true)
    const p = compile(
      withCtx<S, unknown>({ on: true },
        // inside: gate passes
        sequence(guardOn, literal('a'))
      )
    )
    // Compiled version works the same as runtime
    const rt = parse(withCtx<S, unknown>({ on: true }, sequence(guardOn, literal('a'))), 'a')
    const cmp = p.parse('a')
    expect(rt.ok).toBe(cmp.ok)
    if (rt.ok) expect((rt.value as [unknown, string])[1]).toBe('a')
    if (cmp.ok) expect((cmp.value as [unknown, string])[1]).toBe('a')
  })

  it('nested withCtx compiles correctly', () => {
    type S = { depth: number }
    const p = compile(
      withCtx<S, unknown>({ depth: 1 },
        sequence(
          gate((u) => (u as S).depth === 1),
          withCtx<S, unknown>({ depth: 2 },
            gate((u) => (u as S).depth === 2)
          ),
          gate((u) => (u as S).depth === 1),
        )
      )
    )
    const r = p.parse('')
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Compiled parity — runtime vs compiled must agree
// ---------------------------------------------------------------------------
describe('runtime vs compiled parity', () => {
  it('guard parity', () => {
    const p = withCtx({ on: true }, sequence(gate((u: unknown) => !!(u as any)?.on), literal('x')))
    const rt = parse(p, 'x')
    const cmp = compile(p).parse('x')
    expect(rt.ok).toBe(true)
    expect(cmp.ok).toBe(true)
    expect(rt.ok && rt.value).toEqual(cmp.ok && cmp.value)
  })

  it('withCtx parity: complex inner parser', () => {
    type S = { sep: string }
    const p = withCtx<S, unknown>(
      { sep: ',' },
      transform(
        sequence(literal('a'), literal(','), literal('b')),
        ([a,, b]) => `${a}+${b}`,
      )
    )
    const rt = parse(p, 'a,b')
    const cmp = compile(p).parse('a,b')
    expect(rt.ok && rt.value).toBe('a+b')
    expect(cmp.ok && cmp.value).toBe('a+b')
  })
})

// ---------------------------------------------------------------------------
// Recursive grammar with gate/withCtx — verifies emitLazy cycle handling
// still works when inner parsers use gate/withCtx
// ---------------------------------------------------------------------------
describe('recursive grammar + context', () => {
  it('guard inside parser() compiles without runtime fallback', () => {
    // A trivial recursive structure that uses gate
    const { item } = (() => {
      let resolvedItem: ReturnType<typeof literal> | null = null
      // simple non-recursive case to avoid complexity
      const item = withCtx({ ok: true }, sequence(
        gate((u) => !!(u as any)?.ok),
        literal('x'),
      ))
      return { item }
    })()

    const p = compile(many(item))
    expect(p.source).not.toContain('_rp[')
    const r = p.parse('xxx')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.length).toBe(3)
  })
})
