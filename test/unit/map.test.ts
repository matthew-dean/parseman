import { describe, it, expect } from 'vitest'
import { literal, skip, parse } from '../../src/index.ts'

describe('skip()', () => {
  it('extends the span when main and skipped both succeed', () => {
    const p = skip(literal('foo'), literal(' '))
    const r = parse(p, 'foo bar')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('foo')
      expect(r.span).toEqual({ start: 0, end: 4 })
    }
  })

  it('returns main failure when main does not match', () => {
    const p = skip(literal('foo'), literal(' '))
    const r = parse(p, 'bar')
    expect(r.ok).toBe(false)
  })

  it('returns main result unchanged when skipped does not match', () => {
    const p = skip(literal('foo'), literal(' '))
    const r = parse(p, 'foox')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('foo')
      expect(r.span).toEqual({ start: 0, end: 3 })
    }
  })
})
