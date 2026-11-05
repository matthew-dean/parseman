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
 *
 * A build given a corpus (`assemblyProfile`) ranks by measured calls, and takes
 * sites connected: every call from an emitted site to a closure site, or back,
 * crosses the engine boundary through a wrapper, so a hot site beside the emitted
 * ones is worth more than the same site alone. Ranking by calls per byte alone
 * leaves islands: on Jess's Less grammar at budget 0.5, it made 6.7% to 9.0% more calls
 * per parse than the static ranking.
 */
import { childSlots } from './child-slots.ts'
import { OP_CHOICE, OP_DISPATCH, OP_GAPGATE, OP_REP, OP_REPV } from './ops.ts'

const LOOP = 8
const ROUNDS = 60
const CAP = 1e12
/**
 * What a crossing a site removes counts for, against one call of the site itself.
 * 1, 4 and 16 were tried on a prototype and 4 was kept. On real builds of Jess's
 * grammars, 4 made fewer calls than either ranking without it on every file and budget
 * measured, including files held out of that choice. Only 4 has been measured that way:
 * the numbers are in `docs/future/perf-attempts.md`.
 */
const CROSSING_WEIGHT = 4

/**
 * The sites to emit: highest weight per byte first, stopping at the first that
 * does not fit in `budget` bytes. Stopping rather than skipping is what makes a
 * larger budget a superset: a skip lets a budget that just admits a big site lose
 * the small ones a smaller budget took after skipping it. Insertion order is rank.
 */
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
  let spent = 0
  for (const ip of profile === undefined ? staticRanking(code, entries, siteBytes) : connectedRanking(code, siteBytes, profile)) {
    spent += siteBytes.get(ip)!
    if (spent > budget) break
    selected.add(ip)
  }
  return selected
}

/** The sites by estimated weight per byte. Ties (saturated cycles) break by site
 * offset, so a build is deterministic. */
function staticRanking(code: readonly number[], entries: readonly number[], siteBytes: ReadonlyMap<number, number>): number[] {
  const weight = staticWeights(code, entries)
  const w = (ip: number): number => weight.get(ip) ?? 0
  return [...siteBytes.keys()].filter(ip => w(ip) > 0).sort((a, b) => w(b) / siteBytes.get(b)! - w(a) / siteBytes.get(a)! || a - b)
}

/**
 * The sites the corpus ran, each next one being the best by calls plus the crossings
 * it removes, per byte. A site's crossings with a neighbour are bounded by the calls
 * of whichever is the callee, since the profile counts sites, not edges. The order
 * doesn't depend on the budget, so a larger budget's selection is still a superset.
 *
 * ponytail: rescans every remaining site per pick, O(n^2) in sites the corpus ran.
 * 29 ms of a 53 s build on Jess's Less grammar. A heap if a grammar's ever takes seconds.
 */
function* connectedRanking(code: readonly number[], siteBytes: ReadonlyMap<number, number>, calls: ArrayLike<number>): Generator<number> {
  const callees = new Map<number, number[]>()
  const callers = new Map<number, number[]>()
  const kids: number[] = []
  for (const ip of siteBytes.keys()) {
    kids.length = 0
    childSlots(code, ip, kids)
    const own = kids.map(k => (code[k] === OP_GAPGATE ? code[k + 1]! : k)).filter(k => siteBytes.has(k))
    callees.set(ip, own)
    for (const k of own) {
      const list = callers.get(k)
      if (list === undefined) callers.set(k, [ip])
      else list.push(ip)
    }
  }
  const worth = new Map<number, number>()
  for (const ip of siteBytes.keys()) if (calls[ip]! > 0) worth.set(ip, calls[ip]!)
  while (worth.size > 0) {
    let best = -1
    let bestScore = -1
    for (const [ip, value] of worth) {
      const score = value / siteBytes.get(ip)!
      if (score > bestScore || (score === bestScore && ip < best)) { best = ip; bestScore = score }
    }
    worth.delete(best)
    yield best
    for (const k of callees.get(best)!) {
      const value = worth.get(k)
      if (value !== undefined) worth.set(k, value + CROSSING_WEIGHT * calls[k]!)
    }
    for (const p of callers.get(best) ?? []) {
      const value = worth.get(p)
      if (value !== undefined) worth.set(p, value + CROSSING_WEIGHT * calls[best]!)
    }
  }
}

/**
 * The largest prefix of the ranking whose real source fits `ceiling`. `siteBytes`
 * leaves out what sites add around their bodies, so the estimate can overshoot:
 * each overshoot drops the last site and measures again. Walking down the one
 * order is what keeps a selection a prefix of any larger budget's: that budget has
 * every candidate this one has, so it can never settle on fewer. `undefined` when
 * not even the first site fits.
 */
export function fitHotSites(
  code: readonly number[],
  entries: readonly number[],
  siteBytes: ReadonlyMap<number, number>,
  /** What any selection costs before its first site body. */
  fixed: number,
  ceiling: number,
  sourceBytes: (sites: ReadonlySet<number>) => number,
  profile?: ArrayLike<number>,
): { readonly sites: ReadonlySet<number>; readonly bytes: number } | undefined {
  const ranked = [...selectHotSites(code, entries, siteBytes, ceiling - fixed, profile)]
  for (; ranked.length > 0; ranked.pop()) {
    const sites = new Set(ranked)
    const bytes = sourceBytes(sites)
    if (bytes <= ceiling) return { sites, bytes }
  }
  return undefined
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
