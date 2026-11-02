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
  return new CssNodeObj(type, span.start, span.end, [...children], rawChildren.length, triviaLog.length)
}

// Constructor-built, as a user should build tree nodes: a `new` call has no allocation
// site, so V8 cannot pretenure it (see src/cst/plain.ts). Instances stay plain objects.
function CssSpanFn(this: { start: number; end: number }, start: number, end: number): void { this.start = start; this.end = end }
function CssNodeFn(this: CssNode, type: string, start: number, end: number, children: unknown[], rawCount: number, localTriviaLen: number): void {
  this._tag = 'node'
  this.type = type
  this.span = new CssSpan(start, end)
  this.children = children
  this.rawCount = rawCount
  this.localTriviaLen = localTriviaLen
}
CssSpanFn.prototype = Object.prototype
CssNodeFn.prototype = Object.prototype
const CssSpan = CssSpanFn as unknown as new (start: number, end: number) => { start: number; end: number }
const CssNodeObj = CssNodeFn as unknown as new (type: string, start: number, end: number, children: unknown[], rawCount: number, localTriviaLen: number) => CssNode

export function buildLazyTriviaMap(triviaLog: readonly number[], _input: string): { entries: number } {
  return { entries: Math.floor(triviaLog.length / 2) }
}

export function nilNode(): CssNode {
  return { _tag: 'node', type: 'Nil', span: { start: 0, end: 0 }, children: [], rawCount: 0, localTriviaLen: 0 }
}
