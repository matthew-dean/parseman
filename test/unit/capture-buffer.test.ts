import { describe, it, expect } from 'vitest'
import {
  pushCstChild,
  pushCstLeaf,
  pushCstTriviaEntry,
  cstDeferredTriviaActive,
  beginCstNodeCapture,
  endCstNodeCapture,
  finishCstBuf,
  rollbackCstCaptureAt,
} from '../../src/cst/capture-buffer.ts'
import type { ParseContext } from '../../src/types.ts'
import type { CstCaptureBuf } from '../../src/cst/capture-buffer.ts'

describe('pushCstChild() — legacy collectors', () => {
  it('appends to _cstChildren / _cstRawChildren when no _cstBuf is active', () => {
    const children: unknown[] = []
    const raw: unknown[] = []
    const ctx: ParseContext = { trackLines: false, _cstChildren: children, _cstRawChildren: raw }
    pushCstChild(ctx, 'built', 'raw-entry')
    expect(children).toEqual(['built'])
    expect(raw).toEqual(['raw-entry'])
  })

  it('falls back to _cstLeaves when _cstChildren is absent', () => {
    const leaves: unknown[] = []
    const ctx: ParseContext = { trackLines: false, _cstLeaves: leaves }
    pushCstLeaf(ctx, { _tag: 'leaf', value: 'x', span: { start: 0, end: 1 } })
    expect(leaves).toHaveLength(1)
  })
})

describe('beginCstNodeCapture() / endCstNodeCapture()', () => {
  it('materializes children, rawChildren, and triviaLog from the buffer', () => {
    const ctx: ParseContext = { trackLines: false, captureTrivia: false }
    const saved = beginCstNodeCapture(ctx)
    pushCstChild(ctx, 'a', 'a')
    pushCstChild(ctx, 'b', 'b')
    const out = endCstNodeCapture(ctx, saved)
    expect(out.children).toEqual(['a', 'b'])
    expect(out.rawChildren).toEqual(['a', 'b'])
    expect(out.triviaLog).toEqual([])
  })

  it('keeps source-order counts and rollback without retaining raw entry values', () => {
    const buf: CstCaptureBuf = { noRaw: true, rawLen: 0 }
    const ctx: ParseContext = { trackLines: false, captureTrivia: true, _cstBuf: buf }
    pushCstChild(ctx, 'a', { expensive: 'raw-a' })
    pushCstTriviaEntry(ctx, 1, 2)
    pushCstChild(ctx, 'b', { expensive: 'raw-b' })

    expect(buf).toMatchObject({ rawLen: 2, tl: [1, 2, 1] })
    expect(buf).not.toHaveProperty('raw')
    expect(buf).not.toHaveProperty('rawSingle')

    rollbackCstCaptureAt(ctx, 1, 0, 1, undefined, undefined)
    expect(buf).toMatchObject({ rawLen: 1, single: 'a' })
    const out = finishCstBuf(buf)
    expect(out.children).toEqual(['a'])
    expect(out.rawChildren).toEqual([])
    expect(out.triviaLog).toEqual([])
  })
})

describe('pushCstTriviaEntry() / cstDeferredTriviaActive()', () => {
  it('records labeled trivia into _cstTriviaLog when no buffer is active', () => {
    const log: number[] = []
    const ctx: ParseContext = {
      trackLines: false,
      triviaKindLabels: ['ws'],
      _cstTriviaLog: log,
      _cstRawChildren: [],
    }
    pushCstTriviaEntry(ctx, 0, 2, 0)
    expect(log).toEqual([0, 2, 0, 0])
  })

  it('cstDeferredTriviaActive is true when any trivia collector is present', () => {
    expect(cstDeferredTriviaActive({ trackLines: false, _triviaLog: [] })).toBe(true)
    expect(cstDeferredTriviaActive({ trackLines: false })).toBe(false)
  })
})
