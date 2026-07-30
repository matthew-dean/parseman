/**
 * triviaEntries() — flat trivia-log view accessors.
 *
 * label.test.ts and trivia-kinds.test.ts already exercise `.length`, `.kind()`,
 * and `.text()` via real parses. This file directly exercises the remaining
 * accessors (`.start`, `.end`, `.insertIndex`, `.kindIndex`, `.labels`, `.stride`) across every
 * stride shape the doc comment describes:
 *   - root log, no labels   (stride 2)
 *   - root log, labels      (stride 3)
 *   - node log, no labels   (stride 3)
 *   - node log, labels      (stride 4)
 */
import { describe, it, expect } from 'vitest'
import { buildRootTriviaIndex, buildSelectedRootTriviaIndex, triviaEntries } from '../../src/cst/trivia-entries.ts'

describe('triviaEntries()', () => {
  it('root log without labels: stride 2, start/end read pairs, kindIndex/kind are undefined', () => {
    const log = [0, 3, 5, 9]
    const view = triviaEntries(log)

    expect(view.length).toBe(2)
    expect(view.stride).toBe(2)
    expect(view.labels).toBeUndefined()

    expect(view.start(0)).toBe(0)
    expect(view.end(0)).toBe(3)
    expect(view.start(1)).toBe(5)
    expect(view.end(1)).toBe(9)
    expect(view.insertIndex(0)).toBeUndefined()

    expect(view.kindIndex(0)).toBeUndefined()
    expect(view.kind(0)).toBeUndefined()
  })

  it('root log with labels: stride 3, kindIndex/kind resolve from the trailing number', () => {
    const labels = ['ws', 'comment']
    const log = [0, 3, 1, 5, 9, 0]
    const view = triviaEntries(log, labels)

    expect(view.stride).toBe(3)
    expect(view.labels).toBe(labels)

    expect(view.start(0)).toBe(0)
    expect(view.end(0)).toBe(3)
    expect(view.insertIndex(0)).toBeUndefined()
    expect(view.kindIndex(0)).toBe(1)
    expect(view.kind(0)).toBe('comment')

    expect(view.start(1)).toBe(5)
    expect(view.end(1)).toBe(9)
    expect(view.kindIndex(1)).toBe(0)
    expect(view.kind(1)).toBe('ws')
  })

  it('node log without labels: stride 3 (start, end, insertIdx), kindIndex stays undefined', () => {
    const log = [0, 3, 0, 5, 9, 1]
    const view = triviaEntries(log, undefined, { nodeLog: true })

    expect(view.stride).toBe(3)
    expect(view.start(0)).toBe(0)
    expect(view.end(0)).toBe(3)
    expect(view.insertIndex(0)).toBe(0)
    expect(view.start(1)).toBe(5)
    expect(view.end(1)).toBe(9)
    expect(view.insertIndex(1)).toBe(1)
    expect(view.kindIndex(0)).toBeUndefined()
    expect(view.kind(0)).toBeUndefined()
  })

  it('node log with labels: stride 4 (start, end, insertIdx, kindIndex)', () => {
    const labels = ['ws', 'comment']
    const log = [0, 3, 0, 1, 5, 9, 1, 0]
    const view = triviaEntries(log, labels, { nodeLog: true })

    expect(view.stride).toBe(4)
    expect(view.start(0)).toBe(0)
    expect(view.end(0)).toBe(3)
    expect(view.insertIndex(0)).toBe(0)
    expect(view.kindIndex(0)).toBe(1)
    expect(view.kind(0)).toBe('comment')

    expect(view.start(1)).toBe(5)
    expect(view.end(1)).toBe(9)
    expect(view.insertIndex(1)).toBe(1)
    expect(view.kindIndex(1)).toBe(0)
    expect(view.kind(1)).toBe('ws')
  })

  it('text() slices the input at the entry span regardless of stride', () => {
    const input = '0123456789'
    const view = triviaEntries([2, 5, 7, 9])
    expect(view.text(0, input)).toBe('234')
    expect(view.text(1, input)).toBe('78')
  })

  it('length floors when log.length is not an exact multiple of stride', () => {
    // 5 numbers / stride 2 -> 2 whole entries, remainder ignored.
    const view = triviaEntries([0, 1, 2, 3, 4])
    expect(view.length).toBe(2)
  })
})

describe('buildRootTriviaIndex()', () => {
  it('indexes an unlabeled root log by the surrounding content offsets', () => {
    const index = buildRootTriviaIndex([3, 6, 9, 12])

    expect(index.rootCaptureMode).toBe('allEntries')
    expect(index.entryIndicesAfter(3)).toEqual([0])
    expect(index.entryIndicesBefore(6)).toEqual([0])
    expect(index.entryIndicesAfter(9)).toEqual([1])
    expect(index.entryIndicesBefore(12)).toEqual([1])
    expect(index.entryIndicesBefore(3)).toEqual([])
  })

  it('groups contiguous labeled trivia chunks into one boundary gap', () => {
    const labels = ['ws', 'comment'] as const
    const log = [
      1, 2, 0,
      2, 7, 1,
      7, 8, 0,
      11, 12, 0,
    ]
    const index = buildRootTriviaIndex(log, labels)

    expect(index.entries.stride).toBe(3)
    expect(index.entryIndicesAfter(1)).toEqual([0, 1, 2])
    expect(index.entryIndicesBefore(8)).toEqual([0, 1, 2])
    expect(index.after.get(11)).toEqual([3])
    expect(index.before.get(12)).toEqual([3])
    expect(index.entries.kind(1)).toBe('comment')
  })

  it('returns gap objects for before/after boundary lookups without materializing token values', () => {
    const labels = ['ws', 'comment'] as const
    const input = 'a /*x*/ b'
    const index = buildRootTriviaIndex([
      1, 2, 0,
      2, 7, 1,
      7, 8, 0,
    ], labels)

    const after = index.gapAfter(1)
    const before = index.gapBefore(8)

    expect(after).toBe(before)
    expect(after?.start).toBe(1)
    expect(after?.end).toBe(8)
    expect(after?.entryIndices).toEqual([0, 1, 2])
    expect(after?.hasKind('comment')).toBe(true)
    expect(after?.hasKind('lineComment')).toBe(false)
    expect(after?.text(input)).toBe(' /*x*/ ')
    expect(index.gapBefore(1)).toBeUndefined()
  })

  it('lists source-ordered gaps and filters gaps by one or more labels', () => {
    const labels = ['ws', 'blockComment', 'lineComment'] as const
    const index = buildRootTriviaIndex([
      1, 2, 0,
      2, 7, 1,
      10, 11, 0,
      11, 18, 2,
      20, 21, 0,
    ], labels)

    expect(index.gaps().map(gap => [gap.start, gap.end])).toEqual([
      [1, 7],
      [10, 18],
      [20, 21],
    ])
    expect(index.gapsWithKind('blockComment').map(gap => [gap.start, gap.end])).toEqual([
      [1, 7],
    ])
    expect(index.gapsWithKind(['blockComment', 'lineComment']).map(gap => [gap.start, gap.end])).toEqual([
      [1, 7],
      [10, 18],
    ])
    expect(index.gapsWithKind('missing')).toEqual([])
  })
})

describe('buildSelectedRootTriviaIndex()', () => {
  it('uses generic selected markers while preserving the one owning source range', () => {
    const labels = ['inlineWhitespace', 'blockComment', 'significantNewline'] as const
    // Two arbitrary selected markers belong to one committed trivia range.
    const index = buildSelectedRootTriviaIndex([
      1, 12, 2, 7, 1,
      1, 12, 8, 9, 2,
    ], labels)

    expect(index.rootCaptureMode).toBe('selectedKinds')
    expect(index.entries.length).toBe(2)
    expect(index.entries.kind(0)).toBe('blockComment')
    expect(index.entries.kind(1)).toBe('significantNewline')
    expect(index.gapAfter(1)?.entryIndices).toEqual([0, 1])
    expect(index.gapBefore(12)?.hasKind('blockComment')).toBe(true)
    expect(index.gapBefore(12)?.hasKind('significantNewline')).toBe(true)
    expect(index.gapsWithKind('blockComment').map(gap => [gap.start, gap.end])).toEqual([[1, 12]])
  })
})
