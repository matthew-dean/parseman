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
  return {
    type,
    span: { start: span.start, end: span.end },
    children: [...children],
    rawCount: rawChildren.length,
    triviaLen: triviaLog.length,
  }
}
