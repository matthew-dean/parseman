import { describe, expect, it } from 'vitest'
import {
  annotateSpan,
  annotateTreeSpans,
  buildLineIndex,
  createLineIndex,
  normalizeLineIndex,
  offsetToLineCol,
  recordLineRange,
} from '../../src/index.ts'
import {
  annotateSpanFromLineContext,
  recordLineRangeFromContext,
} from '../../src/line-index.ts'

describe('line index', () => {
  it('builds and incrementally records LF starts', () => {
    expect(createLineIndex()).toEqual({ lineStarts: [0] })
    expect(buildLineIndex('a\r\nb\n')).toEqual({ lineStarts: [0, 3, 5] })

    const index = createLineIndex()
    recordLineRange(index, 'a\nb\nc', 0, 2)
    recordLineRange(index, 'a\nb\nc', 1, 5)
    expect(index.lineStarts).toEqual([0, 2, 2, 4])
    expect(normalizeLineIndex(index)).toBe(index)
    expect(index.lineStarts).toEqual([0, 2, 4])
  })

  it('normalizes speculative indexes in place and restores the origin', () => {
    const index = { lineStarts: [8, 3, 8, 5] }
    expect(normalizeLineIndex(index)).toEqual({ lineStarts: [0, 3, 5, 8] })
    expect(normalizeLineIndex({ lineStarts: [] })).toEqual({ lineStarts: [0] })
  })

  it('tracks only the unscanned suffix through either context index shape', () => {
    const input = 'a\nb\nc\n'
    const off = { trackLines: false, _lineIndex: createLineIndex() }
    recordLineRangeFromContext(off, input, 0, input.length)
    expect(off._lineIndex.lineStarts).toEqual([0])

    const absent = { trackLines: true }
    recordLineRangeFromContext(absent, input, 0, 4)
    expect(absent).not.toHaveProperty('_lineScannedTo')

    const direct = { trackLines: true, _lineIndex: createLineIndex(), _lineScannedTo: 2 }
    recordLineRangeFromContext(direct, input, 0, 6)
    recordLineRangeFromContext(direct, input, 0, 4)
    expect(direct._lineIndex.lineStarts).toEqual([0, 4, 6])
    expect(direct._lineScannedTo).toBe(6)

    const legacy: { trackLines: boolean; _lineStarts: number[]; _lineScannedTo?: number } = {
      trackLines: true,
      _lineStarts: [0],
    }
    recordLineRangeFromContext(legacy, input, 99, 4)
    expect(legacy._lineStarts).toEqual([0, 2, 4])
    expect(legacy._lineScannedTo).toBe(4)
  })

  it('maps offsets at and around line boundaries and annotates spans', () => {
    const index = buildLineIndex('ab\nc\n')
    expect(offsetToLineCol(index, 0)).toEqual({ line: 1, col: 1 })
    expect(offsetToLineCol(index, 2)).toEqual({ line: 1, col: 3 })
    expect(offsetToLineCol(index, 3)).toEqual({ line: 2, col: 1 })
    expect(offsetToLineCol(index, 5)).toEqual({ line: 3, col: 1 })
    expect(annotateSpan({ start: 1, end: 4, marker: true } as never, index)).toEqual({
      start: 1,
      end: 4,
      marker: true,
      startLine: 1,
      startColumn: 2,
      endLine: 2,
      endColumn: 2,
    })
  })

  it('annotates from an active direct or legacy line context only', () => {
    const span = { start: 2, end: 3 }
    expect(annotateSpanFromLineContext(span, { trackLines: false, _lineIndex: buildLineIndex('a\nb') })).toBe(span)
    expect(annotateSpanFromLineContext(span, { trackLines: true })).toBe(span)
    expect(annotateSpanFromLineContext(span, { trackLines: true, _lineStarts: [0, 2] })).toMatchObject({
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 2,
    })
  })

  it('annotates every reachable span once without recursing forever on cycles', () => {
    const root: Record<string, unknown> = {
      span: { start: 0, end: 1 },
      children: [
        { span: { start: 2, end: 3 } },
        { span: { start: 'invalid', end: 3 } },
        null,
      ],
      scalar: 'x',
    }
    root.self = root

    expect(annotateTreeSpans(root, buildLineIndex('a\nb'))).toBe(root)
    expect(root.span).toMatchObject({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 })
    expect((root.children as Array<{ span?: object }>)[0]!.span).toMatchObject({
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 2,
    })
    expect((root.children as Array<{ span?: object }>)[1]!.span).toEqual({ start: 'invalid', end: 3 })
    expect(annotateTreeSpans('scalar', createLineIndex())).toBe('scalar')
  })
})
