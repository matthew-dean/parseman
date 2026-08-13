import {
  OP_ADJ, OP_ARMGATE, OP_ATTEMPT, OP_CHOICE, OP_COV, OP_DISPATCH, OP_EMPTY, OP_EXPECT,
  OP_FIELD, OP_GATE, OP_GREEDY, OP_GUARD, OP_LABEL, OP_LEAF, OP_LIT, OP_LIT_CI,
  OP_LIT_CI_TRACK, OP_LIT_TRACK, OP_LIVE, OP_NODE, OP_NODE_TRACK, OP_NOT, OP_OPT,
  OP_PEEK, OP_REJECT, OP_REP, OP_REPV, OP_ROUTED, OP_RULE, OP_RX, OP_RX_TRACK, OP_SCAN,
  OP_SCOPE, OP_SCOPE_CAP, OP_SCOPE_PLAIN, OP_SEQ, OP_SEQV, OP_SEQX, OP_TOKEN, OP_WITHCTX, OP_XFORM,
  OP_LEX_BODY,
} from './ops.ts'

/**
 * THE EDGE TABLE. Which operand slots of an instruction are CHILD instructions.
 *
 * This is one fact about the operand layout, and it was written twice: once in
 * `site-labels.ts` over the 35 opcodes `emit-assembly.ts` lowers, once fused into
 * `inspect.ts`'s `reachableIps` traversal over all 40. The two agreed slot-for-slot
 * on every opcode both covered — which is the problem, not the reassurance. Adding
 * an opcode meant editing two switches in two files, and NOTHING failed if you
 * edited one. `site-labels.ts`'s own header names that failure mode, then guards
 * only against it happening WITHIN that file.
 *
 * The subset was never load-bearing. The five opcodes it omitted — COV, GREEDY,
 * REJECT, ARMGATE, WITHCTX — are exactly the five `emit-assembly.ts` has no case
 * for, so any program containing one throws `Unemittable` from the default arm and
 * the whole assembly falls back to closures. Walking into their subtrees can
 * therefore only affect a result that is about to be discarded. (Verified: none of
 * the five is so much as imported by `emit-assembly.ts`. Its one consumer of these
 * edges, the `fd`/`er` sink census, is computed before the lowering that throws.)
 *
 * `code` is `ArrayLike<number>` because the two callers hold different
 * representations of the same stream — `TableProgram.code` is a `readonly number[]`,
 * `ResolvedTable.code` is an `Int32Array`.
 *
 * Returns false for an opcode this table does not know, so each caller keeps its own
 * answer to that: `inspect.ts` throws (a program it cannot decode is a bug it must
 * report), `site-labels.ts` ignores it (an unwalked site resolves to `TOP` via
 * `labelAt`, and the enclosing assembly is unemittable anyway).
 */
export function childSlots(code: ArrayLike<number>, ip: number, out: number[]): boolean {
  switch (code[ip]) {
    // ZERO-WIDTH / TERMINAL ROWS — no successor. `OP_GUARD` and `OP_ADJ` are both
    // childless tests. `OP_LIVE` holds a hand-written combinator in `prog.fns`; its
    // structure is a closure, so there is no successor row to reach.
    case OP_LIT: case OP_RX: case OP_LIT_TRACK: case OP_RX_TRACK: case OP_EMPTY:
    case OP_SCAN: case OP_LIT_CI: case OP_LIT_CI_TRACK:
    case OP_GUARD: case OP_ADJ: case OP_LIVE: case OP_LEX_BODY:
      return true

    // Single child at `ip + 1`. `OP_COV` is a wrapper on the same footing as the
    // rest — a coverage-encoded program is a program, and omitting it made
    // `opHistogram` throw on every table the coverage build produces.
    case OP_RULE: case OP_OPT: case OP_NOT: case OP_PEEK: case OP_EXPECT:
    case OP_TOKEN: case OP_ATTEMPT: case OP_LABEL: case OP_COV: case OP_REJECT:
      out.push(code[ip + 1]!)
      return true

    // Single child at `ip + 2`.
    case OP_GATE: case OP_SCOPE: case OP_SCOPE_CAP: case OP_SCOPE_PLAIN: case OP_WITHCTX: case OP_XFORM:
    case OP_NODE: case OP_NODE_TRACK: case OP_FIELD: case OP_LEAF: case OP_ARMGATE:
      out.push(code[ip + 2]!)
      return true

    // `ROUTED fallback` — the operand is an offset or −1. The routed token itself is
    // data the enclosing `dispatch()` already consumed, so the only edge is the
    // fallback.
    case OP_ROUTED:
      if (code[ip + 1]! >= 0) out.push(code[ip + 1]!)
      return true

    // `DISPATCH sel d other otherRouted n a1 … an` — the SELECTOR is a child on
    // exactly the same footing as the arms: it runs inside whatever node and scope
    // this site sits in.
    case OP_DISPATCH: {
      out.push(code[ip + 1]!)
      if (code[ip + 3]! >= 0) out.push(code[ip + 3]!)
      const n = code[ip + 5]!
      for (let i = 0; i < n; i++) out.push(code[ip + 6 + i]!)
      return true
    }

    case OP_SEQ: case OP_SEQV: {
      const n = code[ip + 1]!
      for (let i = 0; i < n; i++) out.push(code[ip + 2 + i]!)
      return true
    }

    case OP_SEQX: {
      const n = code[ip + 2]!
      for (let i = 0; i < n; i++) out.push(code[ip + 3 + i]!)
      return true
    }

    case OP_CHOICE: {
      const n = code[ip + 2]!
      for (let i = 0; i < n; i++) out.push(code[ip + 4 + i]!)
      return true
    }

    // Arms are stride-2 from `ip + 4` — the gate word sits beside each arm offset.
    case OP_GREEDY: {
      out.push(code[ip + 1]!)
      const n = code[ip + 2]!
      for (let i = 0; i < n; i++) out.push(code[ip + 4 + 2 * i]!)
      return true
    }

    case OP_REP: case OP_REPV:
      out.push(code[ip + 1]!)
      if (code[ip + 4]! >= 0) out.push(code[ip + 4]!)
      return true

    default:
      return false
  }
}
