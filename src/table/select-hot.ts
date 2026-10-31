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
import { OP_CHOICE, OP_DISPATCH, OP_REP, OP_REPV } from './ops.ts'

const LOOP = 8
const ROUNDS = 60
const CAP = 1e12

/** The sites to emit: the highest weight per byte first, until the next one does not fit in `budget` bytes. */
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
  // STABLE UNDER SMALL EDITS. A static rank is an estimate, so it is compared in
  // quarter-octave steps of weight per byte: a site whose body grows or shrinks by
  // a few bytes keeps its place. Ties break by where the site sits in its rule
  // (`sitePaths`), not by its offset, which every edit earlier in the table moves.
  // A measured profile is exact and keeps exact ratios. The budget buys a PREFIX
  // of that order: skipping a site that does not fit to take a smaller one after
  // it made which sites ship depend on every body's exact size.
  const paths = sitePaths(code, entries)
  const rank = (ip: number): number => {
    const r = w(ip) / siteBytes.get(ip)!
    if (r <= 0) return -Infinity
    return profile !== undefined ? r : Math.round(Math.log2(r) * 4)
  }
  const ranked = [...siteBytes.keys()].sort((a, b) =>
    (rank(b) === rank(a) ? 0 : rank(b) > rank(a) ? 1 : -1) || comparePaths(paths.get(a), paths.get(b)) || a - b)
  let spent = 0
  for (const ip of ranked) {
    if (w(ip) === 0) break
    const bytes = siteBytes.get(ip)!
    if (spent + bytes > budget) break
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
      for (const kid of kids) next.set(kid, Math.min(CAP, (next.get(kid) ?? 0) + w * scale))
    }
    weight = next
  }
  return weight
}

/**
 * Each site's place in the grammar: the entry it is first reached from and the
 * child slots on the way down, depth first. An edit elsewhere in the table moves
 * offsets but not these paths.
 */
function sitePaths(code: readonly number[], entries: readonly number[]): Map<number, readonly number[]> {
  const paths = new Map<number, readonly number[]>()
  const kids: number[] = []
  entries.forEach((entry, e) => {
    const stack: Array<[number, readonly number[]]> = [[entry, [e]]]
    while (stack.length > 0) {
      const [ip, path] = stack.pop()!
      if (paths.has(ip)) continue
      paths.set(ip, path)
      kids.length = 0
      childSlots(code, ip, kids)
      for (let i = kids.length - 1; i >= 0; i--) if (!paths.has(kids[i]!)) stack.push([kids[i]!, [...path, i]])
    }
  })
  return paths
}

function comparePaths(a: readonly number[] | undefined, b: readonly number[] | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}
