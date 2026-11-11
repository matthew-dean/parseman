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
import { OP_CHOICE, OP_CONT, OP_DISPATCH, OP_GAPGATE, OP_REP, OP_REPV, OP_SEED } from './ops.ts'

const LOOP = 8
const ROUNDS = 60
const CAP = 1e12
/**
 * What a crossing a site removes counts for, against one call of the site itself.
 * Better than no weight, on every file and budget measured with real builds of
 * Jess's grammars, but not tuned: 1 and 16 were only tried on a prototype, 2 and 8
 * were never tried, and only 4 has been built and measured.
 */
const CROSSING_WEIGHT = 4
const TAKEN = -1

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

/**
 * The sites the function for `ip` calls, as `emit-assembly.ts` lowers it. An `OP_CONT`
 * with a body is a late frame, lowered with its wrapper in one function, calling its
 * corner and its tail. With no body, the emitter can't decide there and it's an alias
 * to its wrapper, as `OP_SEED` is to its corner. A gap gate has no body either, so its
 * item counts as the repeat's own child, and adding the row moves no other site's
 * estimate (`gap-gate.ts`).
 */
export function edgesAsLowered(code: readonly number[], siteBytes: ReadonlyMap<number, number>, ip: number, out: number[]): void {
  out.length = 0
  if (code[ip] !== OP_CONT) childSlots(code, ip, out)
  else if (siteBytes.has(ip)) out.push(code[ip + 1]!, code[ip + 3]!)
  else out.push(code[ip + 2]!)
  for (let i = 0; i < out.length; i++) {
    let row = out[i]!
    for (;;) {
      const op = code[row]
      if (op === OP_GAPGATE || op === OP_SEED) row = code[row + 1]!
      else if (op === OP_CONT && !siteBytes.has(row)) row = code[row + 2]!
      else break
    }
    out[i] = row
  }
}

/** The sites by estimated weight per byte. Ties (saturated cycles) break by site
 * offset, so a build is deterministic. */
function staticRanking(code: readonly number[], entries: readonly number[], siteBytes: ReadonlyMap<number, number>): number[] {
  const weight = staticWeights(code, entries, siteBytes)
  const w = (ip: number): number => weight.get(ip) ?? 0
  return [...siteBytes.keys()].filter(ip => w(ip) > 0).sort((a, b) => w(b) / siteBytes.get(b)! - w(a) / siteBytes.get(a)! || a - b)
}

/**
 * The sites the corpus ran, each next one being the best by calls plus the crossings
 * it removes, per byte. A crossing with a neighbour is estimated by the calls of
 * whichever is the callee, since the profile counts sites, not edges. Nothing bounds
 * the sum: a callee with N emitted callers gains N crossings' worth of its own calls,
 * and `sequence(g.A, g.A)` counts twice. The order doesn't depend on the budget, so a
 * larger budget's selection is still a superset.
 *
 * ponytail: rescans every site per pick, O(n^2) in sites the corpus ran. 3 ms of a
 * 50 s build on Jess's Less grammar. A heap if a grammar's ever takes seconds.
 */
function* connectedRanking(code: readonly number[], siteBytes: ReadonlyMap<number, number>, calls: ArrayLike<number>): Generator<number> {
  // Ascending, so the first best a scan meets is the lowest: a tie breaks by site.
  const ran = [...siteBytes.keys()].filter(ip => calls[ip]! > 0).sort((a, b) => a - b)
  const slot = new Map(ran.map((ip, i) => [ip, i]))
  const bytes = ran.map(ip => siteBytes.get(ip)!)
  const worth = ran.map(ip => calls[ip]!)
  const score = worth.map((value, i) => value / bytes[i]!)
  const crossings: [neighbour: number, gain: number][][] = ran.map(() => [])
  const kids: number[] = []
  ran.forEach((ip, from) => {
    edgesAsLowered(code, siteBytes, ip, kids)
    for (const callee of kids) {
      const to = slot.get(callee)
      if (to === undefined) continue
      const gain = CROSSING_WEIGHT * calls[callee]!
      crossings[from]!.push([to, gain])
      crossings[to]!.push([from, gain])
    }
  })
  for (let left = ran.length; left > 0; left--) {
    let best = 0
    for (let i = 1; i < score.length; i++) if (score[i]! > score[best]!) best = i
    score[best] = TAKEN
    yield ran[best]!
    for (const [neighbour, gain] of crossings[best]!) {
      if (score[neighbour] === TAKEN) continue
      worth[neighbour] = worth[neighbour]! + gain
      score[neighbour] = worth[neighbour]! / bytes[neighbour]!
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

function staticWeights(code: readonly number[], entries: readonly number[], siteBytes: ReadonlyMap<number, number>): Map<number, number> {
  let weight = new Map<number, number>()
  const kids: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const next = new Map<number, number>()
    for (const ip of entries) next.set(ip, 1)
    for (const [ip, w] of weight) {
      edgesAsLowered(code, siteBytes, ip, kids)
      const op = code[ip]
      const scale = op === OP_REP || op === OP_REPV ? LOOP
        : op === OP_CHOICE || op === OP_DISPATCH ? 1 / Math.max(1, kids.length)
        : 1
      for (const kid of kids) next.set(kid, Math.min(CAP, (next.get(kid) ?? 0) + w * scale))
    }
    weight = next
  }
  return weight
}
