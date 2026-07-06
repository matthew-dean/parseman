import { describe, it, expect } from 'vitest'
import { literal, parse, compile } from '../../src/index.ts'

describe('literal', () => {
  it('matches an exact string', () => {
    const r = parse(literal('hello'), 'hello')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('hello')
      expect(r.span).toEqual({ start: 0, end: 5 })
    }
  })

  it('fails on mismatch', () => {
    const r = parse(literal('hello'), 'world')
    expect(r.ok).toBe(false)
  })

  it('fails when input is too short', () => {
    const r = parse(literal('hello'), 'he')
    expect(r.ok).toBe(false)
  })

  it('matches case-insensitively', () => {
    const p = literal('GET', { caseInsensitive: true })
    expect(parse(p, 'GET').ok).toBe(true)
    expect(parse(p, 'get').ok).toBe(true)
    expect(parse(p, 'Get').ok).toBe(true)
    expect(parse(p, 'gxt').ok).toBe(false)
  })

  it('case-insensitive: interpreter and compiled agree, and capture keeps input casing', () => {
    const p = literal('GET', { caseInsensitive: true })
    const c = compile(p)
    for (const [input, ok] of [['GET', true], ['get', true], ['gEt', true], ['pet', false]] as const) {
      expect(parse(p, input).ok).toBe(ok)
      expect(c.parse(input).ok).toBe(ok)
    }
    // capture is the input's own casing, not the pattern's
    const r = parse(p, 'get')
    expect(r.ok && r.value).toBe('get')
    const rc = c.parse('gEt')
    expect(rc.ok && rc.value).toBe('gEt')
  })

  it('case-insensitive folds ASCII letters only (no Unicode case-fold — was Intl.Collator)', () => {
    // The fold is `(c | 32)` — ASCII A–Z ↔ a–z. Non-ASCII letters are matched
    // EXACTLY, unlike the removed Collator (which accent-folded É↔é). Intentional:
    // locale-independent and correct for CSS/Less keywords.
    const p = literal('café', { caseInsensitive: true })
    const c = compile(p)
    expect(parse(p, 'CAFé').ok).toBe(true)   // ASCII part folds, é matches é
    expect(c.parse('CAFé').ok).toBe(true)
    expect(parse(p, 'CAFÉ').ok).toBe(false)  // É (U+00C9) ≠ é — non-ASCII, exact only
    expect(c.parse('CAFÉ').ok).toBe(false)
  })

  it('reports correct span at offset', () => {
    const p = literal('world')
    const r = p.parse('hello world', 6, { trackLines: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.span).toEqual({ start: 6, end: 11 })
  })
})
