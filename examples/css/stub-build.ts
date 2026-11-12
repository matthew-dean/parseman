/**
 * CST-shaped node builder for CSS perf regression — no Jess AST, but every
 * node() rule allocates a tree node from captured children (no collapse).
 */
import { CssNodeObject } from './css-node.js'

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
  return new CssNodeObject(type, span.start, span.end, [...children], rawChildren.length, triviaLog.length)
}

/** `rows` is `RunResult.rootTrivia.rows`: five numbers per trivia gap. */
export function buildLazyTriviaMap(rows: ArrayLike<number>, _input: string): { entries: number } {
  return { entries: Math.floor(rows.length / 5) }
}

export function nilNode(): CssNode {
  return new CssNodeObject('Nil', 0, 0, [], 0, 0)
}
