/**
 * `gate()` — gate a parser on runtime state.
 *
 * This file previously also pinned the deprecated `guard()` alias. `guard` was
 * removed (see CHANGELOG 0.44.0), so only the real name is covered. The FAILURE
 * LABEL is still the string `'guard'`, deliberately: it is the combinator's
 * internal tag and part of byte-identical compiled output, so it is pinned here
 * rather than tidied away alongside the alias.
 */
import { describe, it, expect } from 'vitest'
import { gate, withCtx, sequence, literal, parse } from '../../src/index.ts'

describe('gate()', () => {
  it('gates a sequence on runtime state', () => {
    const g = withCtx({ on: true }, sequence(gate((s) => (s as { on: boolean }).on), literal('x')))
    expect(parse(g, 'x').ok).toBe(true)
    const off = withCtx({ on: false }, sequence(gate((s) => (s as { on: boolean }).on), literal('x')))
    expect(parse(off, 'x').ok).toBe(false)
  })

  it('reports the "guard" failure label, which compiled output depends on', () => {
    const r = parse(gate(() => false), '')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.expected).toEqual(['guard'])
  })
})
