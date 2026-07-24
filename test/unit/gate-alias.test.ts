/**
 * The `guard()` → `gate()` rename keeps `guard` as a thin DEPRECATED alias so
 * existing grammars keep working. This pins the alias identity + behaviour.
 */
import { describe, it, expect } from 'vitest'
import { gate, guard, withCtx, sequence, literal, parse, compile } from '../../src/index.ts'

describe('gate() / deprecated guard() alias', () => {
  it('guard is the SAME function as gate', () => {
    expect(guard).toBe(gate)
  })

  it('gate() gates a sequence on runtime state', () => {
    const g = withCtx({ on: true }, sequence(gate((s) => (s as { on: boolean }).on), literal('x')))
    expect(parse(g, 'x').ok).toBe(true)
    const off = withCtx({ on: false }, sequence(gate((s) => (s as { on: boolean }).on), literal('x')))
    expect(parse(off, 'x').ok).toBe(false)
  })

  it('guard() alias behaves identically and keeps the "guard" failure label', () => {
    const viaAlias = guard(() => false)
    const viaGate = gate(() => false)
    expect(parse(viaAlias, '').ok).toBe(false)
    // Failure label unchanged for byte-identical output parity.
    const r = parse(viaAlias, '')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.expected).toEqual(['guard'])
    // Same internal tag → compiles identically.
    expect(compile(viaAlias, undefined, { gating: 'off' }).source)
      .toBe(compile(viaGate, undefined, { gating: 'off' }).source)
  })
})
