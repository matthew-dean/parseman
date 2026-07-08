import { describe, it, expect } from 'vitest'
import { regex, parse } from '../../src/index.ts'

describe('regex', () => {
  it('matches a simple pattern', () => {
    const r = parse(regex(/[0-9]+/), '123abc')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('123')
      expect(r.span).toEqual({ start: 0, end: 3 })
    }
  })

  it('fails when pattern does not match at position', () => {
    const r = parse(regex(/[0-9]+/), 'abc')
    expect(r.ok).toBe(false)
  })

  it('anchors match to current position', () => {
    const p = regex(/[a-z]+/)
    const r = p.parse('123abc', 3, { trackLines: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('abc')
  })

  it('computes firstSet for digit class', () => {
    const p = regex(/[0-9]+/)
    expect(p._meta.firstSet).toMatchObject({ kind: 'ranges' })
  })

  it('detects canMatchNewline for \\n', () => {
    const p = regex(/[\s\S]+/)
    expect(p._meta.canMatchNewline).toBe(true)
  })

  it('does not flag canMatchNewline for digit-only', () => {
    const p = regex(/[0-9]+/)
    expect(p._meta.canMatchNewline).toBe(false)
  })

  it('uses a short-run interpreter scanner and bails to exec for long runs', () => {
    const p = regex(/[0-9]+/)
    const exec = RegExp.prototype.exec
    let calls = 0
    RegExp.prototype.exec = function patchedExec(this: RegExp, input: string) {
      calls++
      return exec.call(this, input)
    }

    try {
      expect(p.parse('123abc', 0, { trackLines: false })).toMatchObject({
        ok: true,
        value: '123',
        span: { start: 0, end: 3 },
      })
      expect(calls).toBe(0)

      const long = `${'9'.repeat(200)}abc`
      expect(p.parse(long, 0, { trackLines: false })).toMatchObject({
        ok: true,
        value: '9'.repeat(200),
        span: { start: 0, end: 200 },
      })
      expect(calls).toBe(1)
    } finally {
      RegExp.prototype.exec = exec
    }
  })

})
