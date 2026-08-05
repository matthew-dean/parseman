import { describe, it, expect } from 'vitest'
import { literal, optional, sequence, transform, parse } from '../../src/index.ts'

/**
 * `skip(main, skipped)` was removed in 0.47.0 as sugar over the general form
 * below: parse `main`, OPTIONALLY consume `skipped` after it, keep `main`'s value
 * and extend the span. These are its original assertions, re-pinned against the
 * replacement so the span behaviour it guarded still has coverage.
 */
const trailing = () => transform(sequence(literal('foo'), optional(literal(' '))), ([x]) => x)

describe('transform(sequence(main, optional(skipped)), ([x]) => x)', () => {
  it('extends the span when main and the optional trailer both succeed', () => {
    const r = parse(trailing(), 'foo bar')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('foo')
      expect(r.span).toEqual({ start: 0, end: 4 })
    }
  })

  it('returns main failure when main does not match', () => {
    const r = parse(trailing(), 'bar')
    expect(r.ok).toBe(false)
  })

  it('returns main result unchanged when the trailer does not match', () => {
    const r = parse(trailing(), 'foox')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('foo')
      expect(r.span).toEqual({ start: 0, end: 3 })
    }
  })
})
