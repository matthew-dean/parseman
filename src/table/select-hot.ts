/**
 * WHICH SITES A SELECTIVE BUILD-TIME ASSEMBLY EMITS.
 *
 * The emitted engine beats the closure engine per site, but its bytes are paid by
 * every process that loads the module. Emitting every site made jess's Less AST
 * artifact 20.8x its grammar source. So a build emits only the sites with the
 * highest ESTIMATED hotness per byte, up to a byte budget, and the closure engine
 * runs the rest (`assemble.ts`, the `HYBRID` path).
 *
 * Hotness is estimated statically, since a macro build has no workload to
 * profile: every rule entry starts at 1, a repetition multiplies its body by
 * `LOOP`, and a choice or dispatch splits its weight evenly across its arms. The
 * weights are propagated `ROUNDS` times, so a recursive cycle saturates at `CAP`
 * instead of diverging. Sites are then taken greedily by weight per emitted byte.
 * A build given a corpus (`assemblyProfile`) ranks by measured calls instead.
 */
import { childSlots } from './child-slots.ts'
import { OP_CHOICE, OP_DISPATCH, OP_GAPGATE, OP_REP, OP_REPV } from './ops.ts'

const LOOP = 8
const ROUNDS = 60
const CAP = 1e12

/** The sites to emit: highest weight per byte first, while they fit in `budget` bytes. */
export function selectHotSites(
  code: readonly number[],
  entries: readonly number[],
  siteBytes: ReadonlyMap<number, number>,
  budget: number,
  /** Measured calls per site (`countSiteVisits` over a corpus). Replaces the
   * static estimate when given. */
  profile?: ArrayLike<number>,
): Set<number> {
  const selected = new Set<number>()
  if (budget <= 0) return selected
  const weight = profile === undefined ? staticWeights(code, entries) : undefined
  const w = (ip: number): number => (weight !== undefined ? weight.get(ip) : profile![ip]) ?? 0
  // Ties (saturated cycles) break by site offset, so a build is deterministic.
  const ranked = [...siteBytes.keys()].sort((a, b) =>
    w(b) / siteBytes.get(b)! - w(a) / siteBytes.get(a)! || a - b)
  let spent = 0
  for (const ip of ranked) {
    if (w(ip) === 0) break
    const bytes = siteBytes.get(ip)!
    if (spent + bytes > budget) continue
    spent += bytes
    selected.add(ip)
  }
  return selected
}

function staticWeights(code: readonly number[], entries: readonly number[]): Map<number, number> {
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
      for (const k of kids) {
        // A gap gate has no body: weigh its item as the repeat's own child, so
        // adding the row moves no other site's estimate (`gap-gate.ts`).
        const kid = code[k] === OP_GAPGATE ? code[k + 1]! : k
        next.set(kid, Math.min(CAP, (next.get(kid) ?? 0) + w * scale))
      }
    }
    weight = next
  }
  return weight
}
