/**
 * WHICH ROWS FAIL CLEAN.
 *
 * A choice, an `optional()` and a repeat item take a rollback mark before they
 * try their child and restore it when the child fails, so a failed attempt leaves
 * nothing in the capture sinks: the open frame's children, raw entries and trivia
 * rows, the fields, the errors and the two trivia logs. Most children never write
 * to a sink before they fail. A terminal fails before it pushes its leaf; a node
 * that fails drops its own frame; a sequence whose later terms cannot fail can
 * only fail in its first term, which has no trivia in front of it. For such a
 * child the mark and the restore are work with nothing to undo.
 *
 * `failsClean(ip)` answers, from the table alone, whether every failure of the
 * row at `ip` leaves every sink as the row found it. Only uncommitted failures
 * count: a committed failure is propagated past every choice, optional and
 * repeat without their restore, so the mark is never read for it.
 *
 * It is one memoised walk, run while the assembler links, so it is paid on the
 * first parse. A rule reached again while it is still being answered counts as
 * dirty, and so does a row whose behaviour is not modelled here: `false` keeps
 * the mark, so every approximation errs towards the old cost, never a wrong tree.
 */
import {
  OP_ATTEMPT, OP_CHOICE, OP_COV, OP_DISPATCH, OP_EMPTY, OP_EXPECT, OP_FIELD, OP_GATE, OP_GUARD, OP_LABEL,
  OP_LEAF, OP_LIT, OP_LIT_CI, OP_LIT_CI_TRACK, OP_LIT_TRACK, OP_NODE, OP_NODE_TRACK, OP_NOT, OP_OPT, OP_PEEK,
  OP_REP, OP_REPV, OP_ROUTED, OP_RULE, OP_RX, OP_RX_TRACK, OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_SEQ,
  OP_SEQV, OP_SEQX, OP_SOURCE_LEAF, OP_TOKEN, OP_WITHCTX, OP_XFORM, OP_GAPGATE,
} from './ops.ts'

export type FailClean = (ip: number) => boolean

/**
 * The child offset of a row that fails exactly when its one child fails and
 * writes nothing of its own first, or −1.
 */
function passChild(code: ArrayLike<number>, ip: number): number {
  switch (code[ip]) {
    case OP_RULE: case OP_LABEL: case OP_COV: case OP_TOKEN: case OP_GAPGATE:
      return code[ip + 1]!
    case OP_GATE: case OP_NODE: case OP_NODE_TRACK: case OP_XFORM: case OP_FIELD: case OP_SCOPE:
    case OP_SCOPE_CAP: case OP_SCOPE_PLAIN: case OP_WITHCTX: case OP_LEAF: case OP_SOURCE_LEAF:
      return code[ip + 2]!
    default:
      return -1
  }
}

/** Sequence terms: `[first offset, count]` packed as the offset of the count word, or −1. */
function seqCount(code: ArrayLike<number>, ip: number): number {
  const op = code[ip]
  return op === OP_SEQ || op === OP_SEQV ? ip + 1 : op === OP_SEQX ? ip + 2 : -1
}

export function failCleanAnalysis(code: ArrayLike<number>): FailClean {
  // Per row: 0 unknown, 1 yes, 2 no, 3 being answered (answered as no).
  const cleanAt = new Uint8Array(code.length)
  const neverAt = new Uint8Array(code.length)

  /** No uncommitted failure at all. */
  const neverFails = (ip: number): boolean => {
    const hit = neverAt[ip]!
    if (hit !== 0) return hit === 1
    neverAt[ip] = 3
    let out = false
    const op = code[ip]
    if (op === OP_OPT || op === OP_EMPTY || op === OP_EXPECT) out = true
    else if (op === OP_REP || op === OP_REPV) out = code[ip + 2] === 0
    else {
      const at = seqCount(code, ip)
      if (at >= 0) {
        out = true
        for (let i = 1, n = code[at]!; out && i <= n; i++) out = neverFails(code[at + i]!)
      } else if (op !== OP_GATE) {
        const c = passChild(code, ip)
        out = c >= 0 && neverFails(c)
      }
    }
    neverAt[ip] = out ? 1 : 2
    return out
  }

  const clean = (ip: number): boolean => {
    const hit = cleanAt[ip]!
    if (hit !== 0) return hit === 1
    cleanAt[ip] = 3
    let out = false
    switch (code[ip]) {
      // A terminal pushes its leaf only on a match; NOT/PEEK/ATTEMPT restore
      // their own mark; OPT, EMPTY and EXPECT do not fail uncommitted.
      case OP_LIT: case OP_RX: case OP_LIT_TRACK: case OP_RX_TRACK: case OP_LIT_CI: case OP_LIT_CI_TRACK:
      case OP_GUARD: case OP_NOT: case OP_PEEK: case OP_ATTEMPT: case OP_EMPTY: case OP_OPT: case OP_EXPECT:
        out = true
        break
      // Min 0 does not fail uncommitted; min 1 fails only with no item kept, and
      // restores the failed item itself.
      case OP_REP: case OP_REPV:
        out = code[ip + 2]! <= 1
        break
      // Only the first term may fail: a later one fails after the terms before it
      // wrote, and after the trivia scanned in front of it.
      case OP_SEQ: case OP_SEQV: case OP_SEQX: {
        const at = seqCount(code, ip)
        const n = code[at]!
        out = n > 0 && clean(code[at + 1]!)
        for (let i = 2; out && i <= n; i++) out = neverFails(code[at + i]!)
        break
      }
      case OP_CHOICE: {
        out = true
        for (let i = 0, n = code[ip + 2]!; out && i < n; i++) out = clean(code[ip + 4 + i]!)
        break
      }
      case OP_ROUTED:
        out = code[ip + 1]! < 0 || clean(code[ip + 1]!)
        break
      // An arm's failure and the fallback's are committed; only the selector's is
      // not, and without a fallback an unknown key fails after the selector wrote.
      case OP_DISPATCH:
        out = code[ip + 3]! >= 0 && clean(code[ip + 1]!)
        break
      default: {
        const c = passChild(code, ip)
        out = c >= 0 && clean(c)
      }
    }
    cleanAt[ip] = out ? 1 : 2
    return out
  }
  return clean
}
