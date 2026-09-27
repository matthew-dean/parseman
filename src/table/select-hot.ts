/**
 * WHICH SITES A SELECTIVE BUILD-TIME ASSEMBLY EMITS.
 *
 * The emitted engine beats the closure engine per site, but its bytes are paid
 * by every process that loads the module (about 114 instructions per byte on a
 * cold start, measured on jess css). Emitting every site made jess css's AST
 * artifact 14x its grammar source for a steady-state win that 11% of those
 * bytes already carried. So a build emits only the sites with the highest
 * ESTIMATED hotness per byte, up to a byte budget, and the closure engine runs
 * the rest (`assemble.ts`, the `HYBRID` path).
 *
 * Hotness is estimated statically, since a macro build has no workload to
 * profile: every rule entry starts at 1, a repetition multiplies its body by
 * `LOOP`, and a choice or dispatch splits its weight evenly across its arms.
 * The weights are propagated `ROUNDS` times, so a recursive cycle saturates at
 * `CAP` instead of diverging. Sites are then taken greedily by weight per
 * emitted byte.
 *
 * Measured on jess css `benchmark.css` (see CHANGELOG 0.50.9): at a body budget
 * of 1x the grammar source this keeps about two-thirds of the whole-assembly
 * steady-state win, against about 90% for a profile-ranked selection of the
 * same size. The gap is the price of not having a profile.
 */
import { childSlots } from './child-slots.ts'
import { OP_CHOICE, OP_DISPATCH, OP_REP, OP_REPV } from './ops.ts'

/**
 * Site-body bytes a module may spend on selective assemblies, as a multiple of
 * its own source length. Chosen by measured marginal win per byte on jess css:
 * each step to 1x repaid its own cold-load cost (about 114 instructions per
 * byte) within one `benchmark.css` parse; the step from 1x to 1.5x returned 17
 * per byte and crossed the 5x artifact ceiling.
 */
export const SELECTIVE_ASSEMBLY_BUDGET = 1

const LOOP = 8
const ROUNDS = 60
const CAP = 1e12

export function selectHotSites(
  code: readonly number[],
  entries: readonly number[],
  siteBytes: ReadonlyMap<number, number>,
  budget: number,
): Set<number> {
  const selected = new Set<number>()
  if (budget <= 0) return selected
  let weight = new Map<number, number>()
  const kids: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const next = new Map<number, number>()
    for (const ip of entries) next.set(ip, 1)
    for (const [ip, w] of weight) {
      kids.length = 0
      childSlots(code, ip, kids)
      const op = code[ip]
      const scale = op === OP_REP || op === OP_REPV ? LOOP
        : op === OP_CHOICE || op === OP_DISPATCH ? 1 / Math.max(1, kids.length)
        : 1
      for (const kid of kids) next.set(kid, Math.min(CAP, (next.get(kid) ?? 0) + w * scale))
    }
    weight = next
  }
  // Ties (saturated cycles) break by site offset, so a build is deterministic.
  const ranked = [...siteBytes.keys()].sort((a, b) =>
    (weight.get(b) ?? 0) / siteBytes.get(b)! - (weight.get(a) ?? 0) / siteBytes.get(a)! || a - b)
  let spent = 0
  for (const ip of ranked) {
    if ((weight.get(ip) ?? 0) === 0) break
    const bytes = siteBytes.get(ip)!
    if (spent + bytes > budget) continue
    spent += bytes
    selected.add(ip)
  }
  return selected
}
