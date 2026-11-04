/**
 * A GAP HELD OVER A LOOKAHEAD.
 *
 * In a sequence, the trivia before each term is scanned and recorded, and when
 * the term matches nothing it is unrecorded and the cursor goes back before it:
 * the next term scans the same gap again. Where the term that matched nothing is
 * a lookahead (`not`/`peek`, always zero-width) and the next term cannot match
 * empty, that second scan reads the same characters from the same position under
 * the same trivia and records the same rows, and the next term then either
 * consumes past the gap or the sequence fails. So the gap is kept: the lookahead
 * runs at the gap's end, the cursor stays there, and the next term starts there
 * with nothing left to scan. One scan where there were two and an undo.
 *
 * Not before an adjacency assertion or a leading-trivia field, which read the
 * cursor from before the gap.
 */
import {
  OP_ADJ, OP_ATTEMPT, OP_CHOICE, OP_COV, OP_EXPECT, OP_FIELD, OP_GATE, OP_LABEL, OP_LEAF, OP_LIT, OP_LIT_CI,
  OP_NODE, OP_NOT, OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX, OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_SEQ,
  OP_SEQV, OP_SEQX, OP_SOURCE_LEAF, OP_TOKEN, OP_WITHCTX, OP_XFORM, OP_GAPGATE,
} from './ops.ts'
import { childSlots } from './child-slots.ts'
import { leadingTriviaFieldAt } from './field-spec.ts'
import { regexCanMatchEmpty } from '../regex/first-set.ts'

const WRAPPERS = new Set([OP_NODE, OP_XFORM, OP_LEAF, OP_SOURCE_LEAF, OP_TOKEN, OP_SCOPE, OP_SCOPE_CAP,
  OP_SCOPE_PLAIN, OP_FIELD, OP_LABEL, OP_EXPECT, OP_WITHCTX, OP_RULE, OP_ATTEMPT, OP_COV, OP_GAPGATE])

/**
 * Can the row at `ip` match empty? `true` wherever it cannot tell. A first-set
 * gate row wraps only a child that cannot (`encode.ts` gates nothing nullable).
 */
export function rowNullable(code: ArrayLike<number>, k: readonly unknown[], ip: number, memo: Map<number, boolean>): boolean {
  const hit = memo.get(ip)
  if (hit !== undefined) return hit
  memo.set(ip, true) // a cycle is answered conservatively
  const op = code[ip]!
  const kids: number[] = []
  let out = true
  if (op === OP_GATE) out = false
  else if (op === OP_LIT || op === OP_LIT_CI) out = (k[code[ip + 1]!] as string).length === 0
  else if (op === OP_RX) { const re = k[code[ip + 1]!]; out = !(re instanceof RegExp) || regexCanMatchEmpty(re.source) }
  else if (op === OP_SEQ || op === OP_SEQV || op === OP_SEQX) {
    childSlots(code, ip, kids)
    out = kids.every(c => rowNullable(code, k, c, memo))
  } else if (op === OP_CHOICE) {
    childSlots(code, ip, kids)
    out = kids.length === 0 || kids.some(c => rowNullable(code, k, c, memo))
  } else if (op === OP_REP || op === OP_REPV) {
    out = code[ip + 2] === 0 || rowNullable(code, k, code[ip + 1]!, memo)
  } else if (WRAPPERS.has(op)) {
    if (childSlots(code, ip, kids) && kids.length === 1) out = rowNullable(code, k, kids[0]!, memo)
  }
  memo.set(ip, out)
  return out
}

/** Term `i` of the sequence at `seq` (terms from `base`, `n` of them) holds its gap. */
export function holdsGap(
  code: ArrayLike<number>, k: readonly unknown[], base: number, n: number, i: number, memo: Map<number, boolean>,
): boolean {
  if (i < 1 || i + 1 >= n) return false
  const term = code[base + i]!
  if (code[term] !== OP_NOT && code[term] !== OP_PEEK) return false
  const next = code[base + i + 1]!
  if (code[next] === OP_ADJ || leadingTriviaFieldAt(code, k, next)) return false
  return !rowNullable(code, k, next, memo)
}
