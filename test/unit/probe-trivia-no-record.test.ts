import { describe, expect, it } from 'vitest'
import { probeTriviaEnd } from '../../src/combinators/trivia-skip.ts'
import { regex } from '../../src/index.ts'
import type { ParseContext } from '../../src/types.ts'

/**
 * `probeTriviaEnd` is documented as finding the end of a trivia run "WITHOUT
 * recording any of it". It was read-only for capture buffers and read-WRITE for
 * line data: both paths call `recordLineRangeFromContext` whenever
 * `ctx.trackLines && trivia.canMatchNewline`, so a zero-width assertion left a
 * line record behind for a gap the parse then re-scanned.
 *
 * Asserted directly against the contract rather than through a grammar, because
 * the observable is context state, not a parse result.
 */
describe('probeTriviaEnd records nothing, including line ranges', () => {
  // A real line index is REQUIRED for this to reproduce: recordLineRangeFromContext
  // returns early when neither _lineIndex nor _lineStarts is present, so a context
  // without one makes the probe look read-only whether it is or not. A first version
  // of this test omitted it and passed against the unfixed code.
  const mk = (): ParseContext => ({
    trivia: regex(/[ \t\n]*/),
    trackLines: true,
    _lineScannedTo: 0,
    _lineIndex: { lineStarts: [0] },
  } as unknown as ParseContext)

  it('finds the end of a newline-bearing gap', () => {
    expect(probeTriviaEnd('a\n\n  b', 1, mk())).toBe(5)
  })

  it('leaves _lineScannedTo exactly as it found it', () => {
    const ctx = mk()
    const before = ctx._lineScannedTo
    probeTriviaEnd('a\n\n  b', 1, ctx)
    expect(ctx._lineScannedTo, 'a read-only probe must not advance line scanning').toBe(before)
  })

  it('is idempotent — probing twice changes nothing', () => {
    const ctx = mk()
    const first = probeTriviaEnd('a\n\n  b', 1, ctx)
    const snapshot = ctx._lineScannedTo
    const second = probeTriviaEnd('a\n\n  b', 1, ctx)
    expect(second).toBe(first)
    expect(ctx._lineScannedTo).toBe(snapshot)
  })
})
