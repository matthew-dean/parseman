import { OP_NAMES } from './ops.ts'
import { childSlots } from './child-slots.ts'
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
  const kids: number[] = []
  while (stack.length > 0) {
    const ip = stack.pop()!
    if (seen.has(ip)) continue
    seen.add(ip)
    kids.length = 0
    // The edge table is `child-slots.ts`, shared with `site-labels.ts`. THROWING on
    // an opcode it does not know is this walk's own contract, not the table's: a
    // program `opHistogram` cannot decode is a bug it must report loudly, and
    // `test/unit/table-driver-ops.test.ts` pins that. The emitter's walk over the
    // same edges deliberately stays silent instead.
    if (!childSlots(code, ip, kids)) throw new Error(`inspect: unknown opcode ${String(code[ip])} at ${ip}`)
    for (let i = 0; i < kids.length; i++) stack.push(kids[i]!)
  }
  return seen
}

export function opHistogram(prog: TableProgram): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [op, n] of reachableOps(prog)) out[OP_NAMES[op] ?? `op${op}`] = n
  return out
}
