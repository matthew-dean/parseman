import { describe, it, expect } from 'vitest'
import { literal, sequence, regex, many, parse } from '../../src/index.ts'
import { trivia } from '../../src/combinators/map.ts'

describe('sequence', () => {
  it('matches all parts in order', () => {
    const p = sequence(literal('hello'), literal(' '), literal('world'))
    const r = parse(p, 'hello world')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual(['hello', ' ', 'world'])
      expect(r.span).toEqual({ start: 0, end: 11 })
    }
  })

  it('fails if any part fails', () => {
    const p = sequence(literal('hello'), literal(' '), literal('world'))
    expect(parse(p, 'hello earth').ok).toBe(false)
  })

  it('auto-skips trivia between terms', () => {
    const ws = trivia(regex(/\s+/))
    const p = sequence(literal('foo'), literal('bar'))
    const r = parse(p, 'foo   bar', { trivia: ws })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(['foo', 'bar'])
  })

  it('inherits first set from first parser', () => {
    const p = sequence(literal('abc'), literal('def'))
    expect(p._meta.firstSet).toMatchObject({ kind: 'ranges' })
  })
})
