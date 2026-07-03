import { describe, it, expect } from 'vitest'
import { buildLineIndex, offsetToLineCol, annotateSpan } from '../../src/index.ts'

describe('buildLineIndex', () => {
  it('single-line string has one entry', () => {
    const idx = buildLineIndex('hello')
    expect(idx.lineStarts).toEqual([0])
  })

  it('tracks newline positions', () => {
    const idx = buildLineIndex('foo\nbar\nbaz')
    expect(idx.lineStarts).toEqual([0, 4, 8])
  })

  it('trailing newline creates empty last line', () => {
    const idx = buildLineIndex('foo\n')
    expect(idx.lineStarts).toEqual([0, 4])
  })
})

describe('offsetToLineCol', () => {
  const input = 'foo\nbar\nbaz'
  const idx = buildLineIndex(input)

  it('offset 0 is line 1 col 1', () => {
    expect(offsetToLineCol(idx, 0)).toEqual({ line: 1, col: 1 })
  })

  it('offset at newline char', () => {
    expect(offsetToLineCol(idx, 3)).toEqual({ line: 1, col: 4 })
  })

  it('offset after newline is next line col 1', () => {
    expect(offsetToLineCol(idx, 4)).toEqual({ line: 2, col: 1 })
  })

  it('offset on third line', () => {
    // 'baz' starts at offset 8
    expect(offsetToLineCol(idx, 10)).toEqual({ line: 3, col: 3 })
  })

  it('start of input', () => {
    expect(offsetToLineCol(buildLineIndex(''), 0)).toEqual({ line: 1, col: 1 })
  })
})

describe('annotateSpan', () => {
  it('fills line/col on a span', () => {
    const input = 'hello\nworld'
    const idx = buildLineIndex(input)
    const span = annotateSpan({ start: 6, end: 11 }, idx)
    expect(span.startLine).toBe(2)
    expect(span.startColumn).toBe(1)
    expect(span.endLine).toBe(2)
    expect(span.endColumn).toBe(6)
  })

  it('span crossing a newline', () => {
    const input = 'foo\nbar'
    const idx = buildLineIndex(input)
    const span = annotateSpan({ start: 2, end: 5 }, idx)
    expect(span.startLine).toBe(1)
    expect(span.startColumn).toBe(3)
    expect(span.endLine).toBe(2)
    expect(span.endColumn).toBe(2)
  })
})

describe('parse with trackLines', () => {
  it('annotates span with line/col when trackLines: true', async () => {
    const { literal, sequence, parse } = await import('../../src/index.ts')
    const p = sequence(literal('foo'), literal('\n'), literal('bar'))
    const r = parse(p, 'foo\nbar', { trackLines: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.startLine).toBe(1)
      expect(r.span.startColumn).toBe(1)
      expect(r.span.endLine).toBe(2)
      expect(r.span.endColumn).toBe(4)
    }
  })

  it('parser({ trackLines: true }) annotates via the grammar wrapper', async () => {
    const { literal, sequence, parser } = await import('../../src/index.ts')
    const p = parser({ trackLines: true }, sequence(literal('foo'), literal('\n'), literal('bar')))
    const r = p.parse('foo\nbar', 0, { trackLines: false })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.startLine).toBe(1)
      expect(r.span.endLine).toBe(2)
      expect(r.span.endColumn).toBe(4)
    }
  })

  it('no line/col without trackLines', async () => {
    const { literal, parse } = await import('../../src/index.ts')
    const r = parse(literal('foo'), 'foo')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.span.startLine).toBeUndefined()
      expect(r.span.startColumn).toBeUndefined()
    }
  })
})
