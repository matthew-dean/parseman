/**
 * buildTriviaIndex() edge cases not covered by test/unit/trivia-index.test.ts
 * (which exercises the happy-path parse-then-index and the documented
 * boundary-trivia opts feature). This file targets the branches vitest
 * coverage flagged as unexercised:
 *   - falsy root (skip visit entirely)
 *   - zero-length trivia entries (`tEnd <= tStart` continue)
 *   - two runs merging into the same before/after key (merge()'s "existing" path)
 *   - recursion into child nodes, skipping non-object/non-node children
 *   - opts with empty input (boundary scan skipped)
 *   - opts with a root that has no `.span` (rootSpan undefined)
 *   - opts where rootSpan.start === 0 (no leading scan) but trailing still runs
 *
 * These are constructed as plain object fixtures (matching NodeWithTrivia's
 * duck-typed shape) rather than real parses, since the goal is to hit exact
 * structural branches deterministically.
 */
import { describe, it, expect } from 'vitest'
import { buildTriviaIndex } from '../../src/cst/trivia-index.ts'

describe('buildTriviaIndex() — edge cases', () => {
  it('falsy root short-circuits `if (root) visit(...)` and returns empty maps', () => {
    const index = buildTriviaIndex(null)
    expect(index.before.size).toBe(0)
    expect(index.after.size).toBe(0)
  })

  it('skips zero-length trivia entries (tEnd <= tStart)', () => {
    const node = {
      span: { start: 0, end: 10 },
      triviaLog: [3, 3, 1], // start === end -> continue, nothing registered
      rawChildren: [{ span: { start: 0, end: 3 } }, { span: { start: 5, end: 10 } }],
      children: [],
    }
    const index = buildTriviaIndex(node, '0123456789')
    expect(index.before.size).toBe(0)
    expect(index.after.size).toBe(0)
  })

  it('merges a second trivia run into an existing map key instead of overwriting it', () => {
    const node = {
      span: { start: 0, end: 20 },
      // Both entries have insertIdx=1, so both register under `before` at raw[1].span.start (6).
      triviaLog: [3, 4, 1, 4, 5, 1],
      rawChildren: [{ span: { start: 0, end: 3 } }, { span: { start: 6, end: 20 } }],
      children: [],
    }
    const index = buildTriviaIndex(node, '01234567890123456789')
    const before = index.before.get(6)
    expect(before?.map(t => t.value)).toEqual(['3', '4'])
  })

  it('recurses into children with a `children` property, ignoring non-object/null/primitive entries', () => {
    const parent = {
      span: { start: 0, end: 10 },
      triviaLog: [],
      rawChildren: [],
      children: [
        {
          span: { start: 0, end: 3 },
          triviaLog: [3, 4, 0],
          rawChildren: [{ span: { start: 4, end: 10 } }],
          children: [],
        },
        'not-an-object',
        42,
        null,
      ],
    }
    const index = buildTriviaIndex(parent, '0123456789')
    expect(index.before.get(4)?.map(t => t.value)).toEqual(['3'])
  })

  it('opts with empty input skips the document-boundary scan entirely', () => {
    const root = { span: { start: 0, end: 3 }, triviaLog: [], rawChildren: [], children: [] }
    const index = buildTriviaIndex(root, '', { trivia: /[ \t]+/ })
    expect(index.before.size).toBe(0)
    expect(index.after.size).toBe(0)
  })

  it('opts with a root lacking `.span` treats end as 0 and still scans trailing trivia', () => {
    const noSpanRoot = { triviaLog: [], rawChildren: [], children: [] }
    const index = buildTriviaIndex(noSpanRoot, '  x', { trivia: /[ \t]+/ })
    // rootSpan is undefined -> leading-trivia branch (`rootSpan && rootSpan.start > 0`) is skipped,
    // but end defaults to 0 and 0 < input.length, so trailing scan runs from offset 0.
    expect(index.after.get(0)?.map(t => t.value)).toEqual(['  '])
  })

  it('opts where rootSpan.start === 0 skips leading scan but still runs the trailing scan', () => {
    const root = { span: { start: 0, end: 3 }, triviaLog: [], rawChildren: [], children: [] }
    const index = buildTriviaIndex(root, 'foo  ', { trivia: /[ \t]+/ })
    expect(index.before.size).toBe(1) // trailing trivia registered as "before EOF", not leading
    expect(index.after.get(3)?.map(t => t.value)).toEqual(['  '])
    expect(index.before.get(5)?.map(t => t.value)).toEqual(['  ']) // trailing also registered as "before EOF"
  })
})
