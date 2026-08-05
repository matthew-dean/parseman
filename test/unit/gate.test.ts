/**
 * `gate()` — gate a parser on runtime state.
 *
 * This file previously also pinned the deprecated `guard()` alias. `guard` was
 * removed (see CHANGELOG 0.44.0), so only the real name is covered.
 *
 * The FAILURE LABEL used to be pinned here as `'guard'`, on the stated grounds
 * that compiled output depended on it. It did not: codegen emitted `'gate'` the
 * whole time, so the two shipped engines reported different expected sets for
 * the same failing input. The label is now the public name on every engine.
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

  it('reports the public name as its failure label, on every engine', () => {
    const r = parse(gate(() => false), '')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.expected).toEqual(['gate'])
  })
})
