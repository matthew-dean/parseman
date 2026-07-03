import { describe, it, expect } from 'vitest'
import { keywords, word, makeWord, parse, compile } from '../../src/index.ts'

describe('keywords', () => {
  it('matches any keyword in the set', () => {
    const kw = keywords(['red', 'green', 'blue'])
    expect(parse(kw, 'red')).toMatchObject({ ok: true, value: 'red' })
    expect(parse(kw, 'green')).toMatchObject({ ok: true, value: 'green' })
    expect(parse(kw, 'blue').ok).toBe(true)
  })

  it('fails on a non-keyword', () => {
    expect(parse(keywords(['red', 'green']), 'purple').ok).toBe(false)
  })

  it('prefers the longest match (longest-first)', () => {
    const kw = keywords(['bord', 'border'])
    const r = parse(kw, 'border')
    expect(r.ok && r.value).toBe('border')
  })

  it('enforces a trailing word boundary', () => {
    const kw = keywords(['red'], { boundary: 'A-Za-z0-9_-' })
    // 'red' inside 'redish' must not match (no boundary after).
    expect(parse(kw, 'redish').ok).toBe(false)
    expect(parse(kw, 'red').ok).toBe(true)
    expect(parse(kw, 'red ').ok).toBe(true)
  })

  it('matches case-insensitively when requested', () => {
    const kw = keywords(['red'], { caseInsensitive: true })
    expect(parse(kw, 'RED').ok).toBe(true)
    expect(parse(kw, 'Red').ok).toBe(true)
  })
})

describe('keywords compile', () => {
  it('inlines keywords() to a charCodeAt dispatch (no RegExp.exec, no runtime fallback)', () => {
    // PERF_IDEAS §8b follow-up: each word is a fixed literal (+ shared boundary
    // lookahead), so this reuses the scannable-run.ts lookahead machinery
    // instead of one RegExp.exec alternation — see emitKeywordsFast.
    const kw = keywords(['true', 'false'], { boundary: '_0-9A-Za-z' })
    const compiled = compile(kw)
    expect(compiled.source).toContain('charCodeAt')
    expect(compiled.source).not.toContain('.exec(input)')
    expect(compiled.source).not.toContain('_rp[')
    expect(compiled.parse('true').ok).toBe(true)
    expect(compiled.parse('trueish').ok).toBe(false)
  })

  it('falls back to sticky regex for caseInsensitive + boundary (unsupported fast-path combo)', () => {
    // Boundary class folding under caseInsensitive isn't implemented (PERF_IDEAS
    // §8d, "/i on char classes" — general case, not yet built) — declines safely
    // rather than risk narrowing which chars the boundary excludes.
    const kw = keywords(['red'], { caseInsensitive: true, boundary: 'A-Za-z0-9_-' })
    const compiled = compile(kw)
    expect(compiled.source).toMatch(/const _re\d+ = /)
    expect(compiled.source).toContain('.exec(input)')
    expect(compiled.parse('RED').ok).toBe(true)
    expect(compiled.parse('REDish').ok).toBe(false)
  })

  it('word() and makeWord() compile identically to keywords', () => {
    const w = word('query')
    const mw = makeWord()('query')
    expect(compile(w).source).not.toContain('_rp[')
    expect(compile(mw).source).not.toContain('_rp[')
    expect(compile(w).source).toContain('charCodeAt')
    expect(compile(mw).source).toContain('charCodeAt')
    expect(compile(w).parse('query').ok).toBe(true)
    expect(compile(mw).parse('queryish').ok).toBe(false)
  })
})
