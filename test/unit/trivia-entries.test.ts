/**
 * triviaEntries() — flat trivia-log view accessors.
 *
 * label.test.ts and trivia-kinds.test.ts already exercise `.length`, `.kind()`,
 * and `.text()` via real parses. This file directly exercises the remaining
 * accessors (`.start`, `.end`, `.kindIndex`, `.labels`, `.stride`) across every
 * stride shape the doc comment describes:
 *   - root log, no labels   (stride 2)
 *   - root log, labels      (stride 3)
 *   - node log, no labels   (stride 3)
 *   - node log, labels      (stride 4)
 */
import { describe, it, expect } from 'vitest'
import { triviaEntries } from '../../src/cst/trivia-entries.ts'

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
    expect(view.start(1)).toBe(5)
    expect(view.end(1)).toBe(9)
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
    expect(view.kindIndex(0)).toBe(1)
    expect(view.kind(0)).toBe('comment')

    expect(view.start(1)).toBe(5)
    expect(view.end(1)).toBe(9)
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
