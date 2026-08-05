import {
  OP_CHOICE, OP_EMPTY, OP_GATE, OP_LEAF, OP_LIT, OP_LIT_TRACK, OP_NAMES, OP_NODE,
  OP_NODE_TRACK, OP_NOT, OP_OPT, OP_PEEK, OP_REP, OP_REPV, OP_RULE, OP_RX,
  OP_RX_TRACK, OP_SCOPE, OP_SEQ, OP_SEQV, OP_XFORM, OP_EXPECT, OP_SEQX, OP_SCAN,
  OP_FIELD, OP_DISPATCH, OP_ROUTED, OP_LIT_CI, OP_LIT_CI_TRACK, OP_TOKEN,
  OP_SCOPE_CAP, OP_WITHCTX, OP_GUARD, OP_ADJ, OP_GREEDY, OP_REJECT, OP_ARMGATE,
} from './ops.ts'
import type { TableProgram } from './program.ts'

/**
 * Walk the REACHABLE instructions of a program.
 *
 * A histogram over the raw word stream is not this: operands are ordinary
 * numbers and collide with opcode values, so counting words would report
 * confident nonsense. Reachability from the rule entries, decoding each
 * instruction's declared width, is the only correct read.
 */
export function reachableOps(prog: TableProgram): Map<number, number> {
  const counts = new Map<number, number>()
  const code = prog.code
  for (const ip of reachableIps(prog)) {
    const op = code[ip]!
    counts.set(op, (counts.get(op) ?? 0) + 1)
  }
  return counts
}

/**
 * The reachable INSTRUCTION OFFSETS, which is what any per-row question needs —
 * an opcode histogram cannot answer "which functions sit behind this row".
 */
export function reachableIps(prog: TableProgram): Set<number> {
  const seen = new Set<number>()
  const stack = Object.values(prog.rules)
  const code = prog.code
  while (stack.length > 0) {
    const ip = stack.pop()!
    if (seen.has(ip)) continue
    seen.add(ip)
    const op = code[ip]!
    switch (op) {
      // ZERO-WIDTH / TERMINAL ROWS — no successor. `OP_GUARD` and `OP_ADJ` are
      // both childless tests; the walk ends at them.
      case OP_LIT: case OP_RX: case OP_LIT_TRACK: case OP_RX_TRACK: case OP_EMPTY: case OP_SCAN: case OP_LIT_CI: case OP_LIT_CI_TRACK:
      case OP_GUARD: case OP_ADJ:
        break
      case OP_GATE:
        stack.push(code[ip + 2]!)
        break
      case OP_RULE: case OP_OPT: case OP_NOT: case OP_PEEK: case OP_EXPECT: case OP_TOKEN:
        stack.push(code[ip + 1]!)
        break
      case OP_SEQ: case OP_SEQV: {
        const n = code[ip + 1]!
        for (let i = 0; i < n; i++) stack.push(code[ip + 2 + i]!)
        break
      }
      case OP_SEQX: {
        const n = code[ip + 2]!
        for (let i = 0; i < n; i++) stack.push(code[ip + 3 + i]!)
        break
      }
      case OP_CHOICE: {
        const n = code[ip + 2]!
        for (let i = 0; i < n; i++) stack.push(code[ip + 4 + i]!)
        break
      }
      case OP_GREEDY: {
        stack.push(code[ip + 1]!)
        const n = code[ip + 2]!
        for (let i = 0; i < n; i++) stack.push(code[ip + 4 + 2 * i]!)
        break
      }
      case OP_REJECT:
        stack.push(code[ip + 1]!)
        break
      // `OP_ARMGATE` carries its gated arm at `ip + 2`, like the other wrappers.
      case OP_ARMGATE:
        stack.push(code[ip + 2]!)
        break
      case OP_ROUTED:
        if (code[ip + 1]! >= 0) stack.push(code[ip + 1]!)
        break
      case OP_DISPATCH: {
        stack.push(code[ip + 1]!)
        if (code[ip + 3]! >= 0) stack.push(code[ip + 3]!)
        const n = code[ip + 5]!
        for (let i = 0; i < n; i++) stack.push(code[ip + 6 + i]!)
        break
      }
      case OP_REP: case OP_REPV:
        stack.push(code[ip + 1]!)
        if (code[ip + 4]! >= 0) stack.push(code[ip + 4]!)
        break
      // `OP_SCOPE_CAP` and `OP_WITHCTX` carry their child at `ip + 2` like
      // `OP_SCOPE`; both were added to the encoder without reaching this walk,
      // so `opHistogram` threw "unknown opcode" on any program containing one.
      case OP_XFORM: case OP_LEAF: case OP_SCOPE: case OP_SCOPE_CAP: case OP_WITHCTX: case OP_FIELD:
        stack.push(code[ip + 2]!)
        break
      case OP_NODE: case OP_NODE_TRACK:
        stack.push(code[ip + 2]!)
        break
      default:
        throw new Error(`inspect: unknown opcode ${String(op)} at ${ip}`)
    }
  }
  return seen
}

export function opHistogram(prog: TableProgram): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [op, n] of reachableOps(prog)) out[OP_NAMES[op] ?? `op${op}`] = n
  return out
}
