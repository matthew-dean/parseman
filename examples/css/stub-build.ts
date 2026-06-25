/**
 * CST-shaped node builder for CSS perf regression — no Jess AST, but every
 * node() rule allocates a tree node from captured children (no collapse).
 */
export type CssNode = {
  _tag: 'node'
  type: string
  span: { start: number; end: number }
  children: unknown[]
  /** Structural child count from rawChildren at build time. */
  rawCount: number
  /** `triviaLog.length` for this node (3 numbers per captured trivia entry). */
  localTriviaLen: number
}

export function mk(
  type: string,
  children: ReadonlyArray<unknown>,
  rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
  triviaLog: readonly number[],
): CssNode {
  return {
    _tag: 'node',
    type,
    span: { start: span.start, end: span.end },
    children: [...children],
    rawCount: rawChildren.length,
    localTriviaLen: triviaLog.length,
  }
}

export function buildLazyTriviaMap(triviaLog: readonly number[], _input: string): { entries: number } {
  return { entries: Math.floor(triviaLog.length / 2) }
}

export function nilNode(): CssNode {
  return { _tag: 'node', type: 'Nil', span: { start: 0, end: 0 }, children: [], rawCount: 0, localTriviaLen: 0 }
}
