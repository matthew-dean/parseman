/**
 * The node shape every workload grammar builds.
 *
 * Deliberately plain data with no methods and no shared identity: the gate
 * compares the two sides' parses by `JSON.stringify`, because the reference side
 * and the head side come from two separate module graphs and cannot share a
 * class. `rawCount` and `triviaLen` are recorded rather than the raw arrays so
 * the comparison stays cheap while still proving both sides captured the same
 * amount of trivia — a reference side that quietly stopped capturing would
 * otherwise look fast for the wrong reason.
 */
export type WorkloadNode = {
  type: string
  span: { start: number; end: number }
  children: unknown[]
  rawCount: number
  triviaLen: number
}

export function mk(
  type: string,
  children: ReadonlyArray<unknown>,
  rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
  triviaLog: readonly number[],
): WorkloadNode {
  return new WorkloadNodeObj(type, span.start, span.end, [...children], rawChildren.length, triviaLog.length)
}
// Constructor-built, as a user should build tree nodes: a `new` call has no allocation
// site, so V8 cannot pretenure it (see src/cst/plain.ts). Instances stay plain objects.
function WorkloadSpanFn(this: { start: number; end: number }, start: number, end: number): void { this.start = start; this.end = end }
function WorkloadNodeFn(this: WorkloadNode, type: string, start: number, end: number, children: unknown[], rawCount: number, triviaLen: number): void {
  this.type = type
  this.span = new WorkloadSpan(start, end)
  this.children = children
  this.rawCount = rawCount
  this.triviaLen = triviaLen
}
WorkloadSpanFn.prototype = Object.prototype
WorkloadNodeFn.prototype = Object.prototype
const WorkloadSpan = WorkloadSpanFn as unknown as new (start: number, end: number) => { start: number; end: number }
const WorkloadNodeObj = WorkloadNodeFn as unknown as new (type: string, start: number, end: number, children: unknown[], rawCount: number, triviaLen: number) => WorkloadNode

