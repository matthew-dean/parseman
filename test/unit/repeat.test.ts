import { describe, it, expect } from 'vitest'
import { literal, regex, many, oneOrMore, optional, sepBy, parse } from '../../src/index.ts'

describe('many', () => {
  it('matches zero times', () => {
    const r = parse(many(literal('x')), '')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([])
  })

  it('matches multiple times', () => {
    const r = parse(many(literal('ab')), 'ababab')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(['ab', 'ab', 'ab'])
  })

  it('stops at non-match', () => {
    const r = parse(many(literal('a')), 'aaab')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual(['a', 'a', 'a'])
      expect(r.span.end).toBe(3)
    }
  })
})

describe('oneOrMore', () => {
  it('fails on zero matches', () => {
    expect(parse(oneOrMore(literal('x')), '').ok).toBe(false)
  })

  it('succeeds on one or more', () => {
    const r = parse(oneOrMore(literal('a')), 'aaa')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toHaveLength(3)
  })
})

describe('optional', () => {
  it('returns value when matched', () => {
    const r = parse(optional(literal('hi')), 'hi')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('hi')
  })

  it('returns null when not matched', () => {
    const r = parse(optional(literal('hi')), 'bye')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeNull()
  })
})

describe('sepBy', () => {
  it('parses comma-separated values', () => {
    const p = sepBy(regex(/[a-z]+/), literal(','))
    const r = parse(p, 'foo,bar,baz')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(['foo', 'bar', 'baz'])
  })

  it('returns empty on no match', () => {
    const p = sepBy(regex(/[a-z]+/), literal(','))
    const r = parse(p, '123')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([])
  })
})

describe('sepBy with trivia', () => {
  it('skips trivia around separators', async () => {
    const { trivia } = await import('../../src/index.ts')
    const ws = trivia(regex(/\s+/))
    const words = sepBy(regex(/[a-z]+/), literal(','))
    const r = parse(words, 'foo , bar , baz', { trivia: ws })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(['foo', 'bar', 'baz'])
  })
})
