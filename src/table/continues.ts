/**
 * WHAT A `continues()` TAIL CAN START WITH, read off the row that runs it.
 *
 * `OP_CONT` asks, after the corner, whether the tail could do anything at the next
 * token. The answer is the repeat's or the optional's own first test (`OP_REP` ip+7
 * and its `OP_GAPGATE`, an `OP_OPT` over `OP_GATE`), so it holds exactly where the row
 * would have ended without entering its item. Any other tail has no answer: the
 * wrapper always opens, and a tail that takes nothing collapses in it as `collapse`
 * does.
 */
import { OP_GAPGATE, OP_GATE, OP_OPT, OP_REP, OP_REPV, OP_RULE, OP_WITHCTX } from './ops.ts'

export type ContinuationGate = {
  /** Class of the first character, past any trivia. */
  readonly cls: number
  /** The regex row of a leading gap, or −1. */
  readonly gapRow: number
  /** Class of the character after the gap. */
  readonly follow: number
  /** Class of an arm that opens without the gap, or −1. */
  readonly other: number
}

export function continuationGate(code: ArrayLike<number>, ip: number): ContinuationGate | undefined {
  let at = ip
  for (let n = 0; n < 8; n++) {
    const op = code[at]
    if (op === OP_RULE) at = code[at + 1]!
    else if (op === OP_WITHCTX) at = code[at + 2]!
    else break
  }
  const op = code[at]
  if (op === OP_OPT) {
    const c = code[at + 1]!
    return code[c] === OP_GATE ? { cls: code[c + 1]!, gapRow: -1, follow: -1, other: -1 } : undefined
  }
  if (op !== OP_REP && op !== OP_REPV) return undefined
  // A separated list keeps ip+7 for its recovery sentinel; a mandatory item reports.
  if (code[at + 2] !== 0 || code[at + 4]! >= 0 || code[at + 7]! < 0) return undefined
  const item = code[at + 1]!
  return code[item] === OP_GAPGATE
    ? { cls: code[at + 7]!, gapRow: code[item + 2]!, follow: code[item + 3]!, other: code[item + 4]! }
    : { cls: code[at + 7]!, gapRow: -1, follow: -1, other: -1 }
}
