/**
 * recover() tests.
 *
 * Error recovery: on failure, skip to sentinel and return a ParseError node.
 * The calling grammar continues parsing from the sentinel position.
 */
import { describe, it, expect } from 'vitest'
import { literal, regex, sequence, choice, many, transform, sepBy, parse } from '../../src/index.ts'
import { recover, isParseError } from '../../src/index.ts'
import type { ParseError } from '../../src/index.ts'

describe('recover() — basic', () => {
  it('returns inner value when parser succeeds', () => {
    const p = recover(literal('ok'), literal(';'))
    const r = parse(p, 'ok')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(isParseError(r.value)).toBe(false)
      expect(r.value).toBe('ok')
    }
  })

  it('returns ParseError when parser fails, skipping to sentinel', () => {
    const p = recover(literal('ok'), literal(';'))
    const r = parse(p, 'bad;rest')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(isParseError(r.value)).toBe(true)
      const err = r.value as ParseError
      expect(err.span.start).toBe(0)
      expect(err.span.end).toBe(3)    // skipped 'bad', stopped before ';'
    }
  })

  it('ParseError span covers only skipped input, not sentinel', () => {
    const p = sequence(
      recover(literal('good'), literal(';')),
      literal(';'),
    )
    // Input: 'broken;' — recover skips 'broken', then sequence parses ';'
    const r = parse(p, 'broken;')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const [recovered, semi] = r.value
      expect(isParseError(recovered)).toBe(true)
      expect((recovered as ParseError).span).toEqual({ start: 0, end: 6 })
      expect(semi).toBe(';')
    }
  })

  it('skips to EOF when sentinel never matches', () => {
    const p = recover(literal('ok'), literal(';'))
    const r = parse(p, 'totally wrong input')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(isParseError(r.value)).toBe(true)
      expect((r.value as ParseError).span.end).toBe(19)  // all input skipped
    }
  })

  it('ParseError carries expected tokens from failed inner parse', () => {
    const p = recover(literal('ok'), literal(';'))
    const r = parse(p, 'bad;')
    expect(r.ok).toBe(true)
    if (r.ok && isParseError(r.value)) {
      expect(r.value.expected).toContain('"ok"')
    }
  })
})

describe('recover() — error tolerant sequence', () => {
  // Practical: parse a list of semicolon-terminated statements,
  // tolerating individual parse failures.
  const stmt = recover(
    transform(regex(/[a-z]+/), s => ({ type: 'stmt' as const, name: s })),
    literal(';'),
  )
  const program = many(sequence(stmt, literal(';')))

  it('parses all-valid program', () => {
    const r = parse(program, 'foo;bar;baz;')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.length).toBe(3)
      expect(r.value.every(([v]) => !isParseError(v))).toBe(true)
    }
  })

  it('recovers from one bad statement', () => {
    const r = parse(program, 'foo;123;baz;')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.length).toBe(3)
      // Middle statement is a ParseError
      const [, [middle]] = r.value as [[unknown, string], [unknown, string], [unknown, string]]
      expect(isParseError(middle)).toBe(true)
      // First and last are valid
      expect(isParseError(r.value[0]![0])).toBe(false)
      expect(isParseError(r.value[2]![0])).toBe(false)
    }
  })

  it('recovers from multiple bad statements', () => {
    const r = parse(program, 'foo;!!!;!!!;baz;')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.length).toBe(4)
      const errors = r.value.filter(([v]) => isParseError(v))
      expect(errors.length).toBe(2)
    }
  })
})

describe('isParseError()', () => {
  it('returns true for ParseError', () => {
    const e: ParseError = { _tag: 'parseError', span: { start: 0, end: 0 }, expected: [] }
    expect(isParseError(e)).toBe(true)
  })

  it('returns false for non-error values', () => {
    expect(isParseError('hello')).toBe(false)
    expect(isParseError(42)).toBe(false)
    expect(isParseError(null)).toBe(false)
    expect(isParseError({ type: 'node' })).toBe(false)
  })
})
