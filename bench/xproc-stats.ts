/**
 * The statistics behind `bench/xproc-gate.ts`'s verdict, kept free of side effects so
 * they can be tested.
 *
 * Each round of the gate gives one value per case: `ln(head / ref)` of the two process
 * medians. On identical code, with the order of the two processes random, a round is as
 * likely to favour either side by any amount, so the values are symmetric about zero.
 * Both tests rest on that symmetry and on nothing else.
 */

/** Exact one-sided binomial tail: P(X >= k) for X ~ Bin(n, 1/2). */
export function signTestP(k: number, n: number): number {
  let p = 0
  let c = 1
  for (let i = 0; i <= n; i++) {
    if (i >= k) p += c
    c = c * (n - i) / (i + 1)
  }
  return p / 2 ** n
}

/**
 * One-sided sign-flip test on the MEAN: how often does flipping the sign of each round
 * at random give a mean at least as large as the one observed?
 *
 * This is the test that sees a regression that lands on SOME processes only, such as a
 * site V8 now pretenures in one process in five. The median and the sign test barely
 * move for that; the mean moves by its full share.
 *
 * All 2^n flips cannot be enumerated at these round counts, so `flips` of them are drawn
 * from `random`. Counting the observed assignment as one of them, `(1 + hits) / (1 + flips)`,
 * keeps the p-value valid at any `flips`: under the null it is never below α more often
 * than α of the time.
 */
export function meanFlipP(d: readonly number[], flips: number, random: () => number): number {
  const observed = d.reduce((s, x) => s + x, 0)
  let hits = 0
  for (let b = 0; b < flips; b++) {
    let s = 0
    for (const x of d) s += random() < 0.5 ? -x : x
    if (s >= observed) hits++
  }
  return (1 + hits) / (1 + flips)
}

export const median = (a: readonly number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const pct = (x: number): number => (Math.exp(x) - 1) * 100

export type VerdictSettings = { floorPct: number; alphaMedian: number; alphaMean: number; flips: number }

export type CaseVerdict = {
  /** Median per-round slowdown, percent. */
  center: number
  /** Mean per-round slowdown, percent (from the mean of the logs). */
  mean: number
  slower: number
  n: number
  pMedian: number
  pMean: number
  failedMedian: boolean
  failedMean: boolean
  failed: boolean
}

/**
 * A case FAILS when either test fails: the median slowdown is above the floor and the
 * sign test is significant, OR the mean slowdown is above the floor and the sign-flip
 * test on the mean is significant. α is split between the two, so identical code fails
 * a case no more often than the two halves add up to.
 */
export function caseVerdict(d: readonly number[], s: VerdictSettings, random: () => number): CaseVerdict {
  if (d.length === 0) throw new Error('caseVerdict: no rounds')
  for (const x of d) if (!Number.isFinite(x)) throw new Error(`caseVerdict: non-finite round ${x}`)
  const slower = d.filter(x => x > 0).length
  const pMedian = signTestP(slower, d.length)
  const pMean = meanFlipP(d, s.flips, random)
  const center = pct(median(d))
  const mean = pct(d.reduce((a, x) => a + x, 0) / d.length)
  const failedMedian = center > s.floorPct && pMedian < s.alphaMedian
  const failedMean = mean > s.floorPct && pMean < s.alphaMean
  return { center, mean, slower, n: d.length, pMedian, pMean, failedMedian, failedMean, failed: failedMedian || failedMean }
}

export type Shard = { reference: string; seed: number; logs: Record<string, number[]>; minLogs: Record<string, number[]> }

/**
 * Merge shard files into per-case rounds, failing CLOSED. A missing, duplicated,
 * truncated, foreign or corrupt shard throws: a shard that crashed must never pass the
 * gate on the rounds the others happened to finish.
 */
export function mergeShards(
  files: ReadonlyArray<{ name: string; text: string }>,
  expected: number,
  reference: string,
  cases: readonly string[],
  roundsFor: (id: string) => number,
): { logs: Map<string, number[]>; minLogs: Map<string, number[]>; seeds: number[] } {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('expected shard count must be a positive integer')
  if (files.length !== expected) {
    throw new Error(`expected ${expected} shard files, found ${files.length}: ${files.map(f => f.name).join(', ')}`)
  }
  const logs = new Map(cases.map(c => [c, [] as number[]]))
  const minLogs = new Map(cases.map(c => [c, [] as number[]]))
  const seeds: number[] = []
  for (const f of files) {
    let shard: Shard
    try {
      shard = JSON.parse(f.text) as Shard
    } catch (error) {
      throw new Error(`shard ${f.name} is not JSON: ${String(error).slice(0, 200)}`)
    }
    if (shard.reference !== reference) throw new Error(`shard ${f.name} measured against ${shard.reference}, not ${reference}`)
    if (!Number.isSafeInteger(shard.seed)) throw new Error(`shard ${f.name} has no seed`)
    if (seeds.includes(shard.seed)) throw new Error(`shard ${f.name} repeats seed ${shard.seed}`)
    seeds.push(shard.seed)
    for (const c of cases) {
      for (const [label, src, into] of [['rounds', shard.logs, logs], ['minima', shard.minLogs, minLogs]] as const) {
        const d = src?.[c]
        if (!Array.isArray(d) || d.length !== roundsFor(c)) {
          throw new Error(`shard ${f.name} has ${Array.isArray(d) ? d.length : 0} ${label} for ${c}, expected ${roundsFor(c)}`)
        }
        for (const x of d) {
          if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`shard ${f.name} has a non-finite ${label} value for ${c}: ${x}`)
        }
        into.get(c)!.push(...d)
      }
    }
  }
  return { logs, minLogs, seeds }
}
