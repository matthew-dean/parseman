/**
 * The statistics behind `bench/xproc-gate.ts`'s verdict, kept free of side effects so
 * they can be tested.
 *
 * Each round of the gate gives one value per case: `ln(head / ref)` of the two process
 * medians. On identical code, with the order of the two processes random, a round is as
 * likely to favour either side by any amount, so the values are symmetric about zero.
 * Both tests rest on that symmetry and on nothing else.
 */

/**
 * Exact one-sided binomial tail: P(X >= k) for X ~ Bin(n, 1/2).
 *
 * Summed in log space. The direct form, `C(n, i)` accumulated in a double over `2 ** n`,
 * overflows near n = 1,024: first to 0 (every case over the floor fails), then to NaN
 * (the median test never fails). 20 shards x 52 rounds already reaches that, so the
 * terms are `exp(ln C(n, i) − n ln 2)`, each in [0, 1].
 */
export function signTestP(k: number, n: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(k)) throw new Error(`signTestP: bad arguments k=${k} n=${n}`)
  if (k <= 0) return 1
  if (k > n) return 0
  const logHalfN = n * Math.LN2
  let logC = 0
  let p = 0
  for (let i = 0; i <= n; i++) {
    if (i >= k) p += Math.exp(logC - logHalfN)
    if (i < n) logC += Math.log((n - i) / (i + 1))
  }
  return Math.min(1, p)
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
  if (!(pMedian >= 0 && pMedian <= 1)) throw new Error(`caseVerdict: sign-test p ${pMedian} is not a probability`)
  const pMean = meanFlipP(d, s.flips, random)
  const center = pct(median(d))
  const mean = pct(d.reduce((a, x) => a + x, 0) / d.length)
  const failedMedian = center > s.floorPct && pMedian < s.alphaMedian
  const failedMean = mean > s.floorPct && pMean < s.alphaMean
  return { center, mean, slower, n: d.length, pMedian, pMean, failedMedian, failedMean, failed: failedMedian || failedMean }
}

export type Shard = {
  reference: string
  seed: number
  /** `process.version` of the node every worker in the shard ran on. */
  node: string
  logs: Record<string, number[]>
  minLogs: Record<string, number[]>
}

/** `v26.13.0` → `26`. */
export const nodeMajor = (version: string): string => /^v(\d+)\./.exec(version)?.[1] ?? ''

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
  /**
   * The node major committed in `bench/xproc-gate.json`. Every shard must have measured
   * on it, and all on ONE exact `process.version`: rounds from two runtimes are two
   * distributions, and the round counts were sized on one.
   */
  node: string,
): { logs: Map<string, number[]>; minLogs: Map<string, number[]>; seeds: number[]; versions: string[] } {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('expected shard count must be a positive integer')
  if (files.length !== expected) {
    throw new Error(`expected ${expected} shard files, found ${files.length}: ${files.map(f => f.name).join(', ')}`)
  }
  const logs = new Map(cases.map(c => [c, [] as number[]]))
  const minLogs = new Map(cases.map(c => [c, [] as number[]]))
  const seeds: number[] = []
  const versions: string[] = []
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
    if (typeof shard.node !== 'string' || nodeMajor(shard.node) === '') throw new Error(`shard ${f.name} does not record its node version`)
    if (nodeMajor(shard.node) !== node) throw new Error(`shard ${f.name} ran on node ${shard.node}, not node ${node}`)
    if (versions.length > 0 && versions[0] !== shard.node) {
      throw new Error(`shard ${f.name} ran on node ${shard.node}, another shard on ${versions[0]}: one verdict, one runtime`)
    }
    versions.push(shard.node)
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
  return { logs, minLogs, seeds, versions }
}

/**
 * The aggregate's own random stream, derived from the shard seeds rather than drawn,
 * so re-running only the aggregate over the same shards gives the same sign-flip
 * p-values and the same verdict.
 */
export function aggregateSeed(seeds: readonly number[]): number {
  let h = 0x811c9dc5
  for (const s of [...seeds].sort((a, b) => a - b)) {
    h = Math.imul(h ^ (s >>> 0), 0x01000193) >>> 0
    h = Math.imul(h ^ (s >>> 16), 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Flags that change WHAT is measured or how it is judged. In shard and aggregate modes,
 * the modes CI's verdict runs in, they are refused, so an edit to `ci.yml` alone cannot
 * shrink the rounds, drop cases, swap the reference or turn the verdict off. Everything
 * they could change is committed in `bench/xproc-gate.json`, where §E guards it.
 */
export const VERDICT_MODE_FORBIDDEN = ['--rounds', '--case', '--suite', '--report-only', '--self', '--ref', '--head-ref'] as const

export function verdictModeArgErrors(argv: readonly string[]): string[] {
  return VERDICT_MODE_FORBIDDEN.filter(flag => argv.some(a => a === flag || a.startsWith(`${flag}=`)))
}

/**
 * Mode flags given without their operand. A bare `--shard-out` or `--aggregate` must
 * fail, not fall back to a plain local run that writes no shard or gives no verdict.
 */
export const OPERAND_FLAGS = ['--shard-out', '--aggregate', '--expect-shards'] as const

export function missingOperandFlags(argv: readonly string[]): string[] {
  return OPERAND_FLAGS.filter(flag => argv.some(a => a === flag || a === `${flag}=`))
}

/**
 * Which reference a verdict-mode run may use, given the one CI resolved once for the
 * run (`--reference`), the previous releases visible now (newest first, each with its
 * tag commit's committer time), and HEAD's committer time.
 *
 * Publish-on-merge tags a release whenever a PR merges, so a tag can land while another
 * PR's run is in flight (the first live failure: shards at v0.58.1, the aggregate at
 * v0.58.2). So the reference is resolved once and passed to every job, and a job may
 * find a newer release than the one it was handed. What is enforced:
 *
 * - the pin is a plain hex sha;
 * - it is the newest previous release, OR the one before it ONLY when the newest one's
 *   tag commit is newer than HEAD's commit, i.e. that release can only have been tagged
 *   after this run's commit was made. Anything else is refused.
 *
 * That stops a run from measuring against an arbitrary older release. It does not make
 * `ci.yml` tamper-proof: an edit there can still change what the jobs run, and remains a
 * human-review boundary.
 *
 * Known false failure: if TWO releases are tagged during one run, the pin is the
 * third-newest and is refused. Re-run the workflow.
 */
export function pinnedReferenceError(
  pinned: string,
  releases: ReadonlyArray<{ tag: string; sha: string; date: number }>,
  headDate: number,
): string | null {
  // A plain hex sha only: `<sha>~5` would pass a prefix match while git resolved an ancestor.
  if (!/^[0-9a-f]{7,40}$/.test(pinned)) return `--reference=${pinned} is not a commit sha`
  const matches = (r: { sha: string }): boolean => r.sha.startsWith(pinned) || pinned.startsWith(r.sha)
  const [newest, before] = releases
  if (newest !== undefined && matches(newest)) return null
  if (before !== undefined && matches(before)) {
    if (newest!.date > headDate) return null
    return `--reference=${pinned} is ${before.tag}, but ${newest!.tag} was tagged before this run's commit, so it was the previous release when the run started`
  }
  return `--reference=${pinned} is not the previous release (${releases.slice(0, 2).map(r => `${r.tag} ${r.sha}`).join(' or ') || 'none'})`
}

/**
 * Flags `--print-reference` refuses: it prints the true previous release (or the
 * committed peak), never one supplied on the command line.
 */
export function printReferenceArgErrors(argv: readonly string[]): string[] {
  return ['--ref', '--reference', '--head-ref', '--self'].filter(flag => argv.some(a => a === flag || a.startsWith(`${flag}=`)))
}
