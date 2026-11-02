import { describe, expect, it } from 'vitest'
import { aggregateSeed, caseVerdict, meanFlipP, mergeShards, missingOperandFlags, pinnedReferenceError, printReferenceArgErrors, signTestP, verdictModeArgErrors, type VerdictSettings } from '../../bench/xproc-stats.ts'

/** Deterministic generator for the tests (mulberry32, as the gate uses). */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

const choose = (n: number, k: number): number => {
  let c = 1
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1)
  return c
}

describe('signTestP', () => {
  it('is the exact one-sided binomial tail', () => {
    for (const n of [1, 5, 12, 40]) {
      for (let k = 0; k <= n; k++) {
        let want = 0
        for (let i = k; i <= n; i++) want += choose(n, i)
        expect(signTestP(k, n)).toBeCloseTo(want / 2 ** n, 12)
      }
    }
    expect(signTestP(0, 10)).toBe(1)
    expect(signTestP(10, 10)).toBeCloseTo(1 / 1024, 15)
    expect(signTestP(11, 10)).toBe(0)
  })

  it('stays a probability past n = 1,024, where the direct form overflows', () => {
    for (const n of [1023, 1024, 1040, 1200, 5000]) {
      let prev = 1
      for (const k of [0, Math.floor(n / 2), Math.floor(n / 2) + Math.floor(Math.sqrt(n)), Math.floor(0.6 * n), n]) {
        const p = signTestP(k, n)
        expect(Number.isFinite(p) && p >= 0 && p <= 1).toBe(true)
        expect(p).toBeLessThanOrEqual(prev)
        prev = p
      }
      // Symmetry. Even n: P(X >= n/2) = 1/2 + P(X = n/2)/2, just above 1/2, and
      // P(X >= n/2 + 1) just below. Odd n: P(X >= (n + 1)/2) is exactly 1/2.
      if (n % 2 === 0) {
        expect(signTestP(n / 2, n)).toBeGreaterThan(0.5)
        expect(signTestP(n / 2 + 1, n)).toBeLessThan(0.5)
      } else {
        expect(signTestP((n + 1) / 2, n)).toBeCloseTo(0.5, 12)
      }
    }
    // A clearly significant excess is still significant at large n.
    expect(signTestP(700, 1200)).toBeLessThan(1e-8)
    // 0.6 of 1,200 rounds slower: z ≈ 6.9, so the tail is about 2.5e-12.
    expect(signTestP(720, 1200)).toBeGreaterThan(1e-13)
    expect(signTestP(720, 1200)).toBeLessThan(1e-10)
  })
})

describe('meanFlipP', () => {
  it('matches full enumeration of the sign flips on a small sample', () => {
    const d = [0.03, -0.01, 0.02, 0.05, -0.02, 0.04, 0.01, 0.0]
    const observed = d.reduce((a, x) => a + x, 0)
    let hits = 0
    for (let mask = 0; mask < 2 ** d.length; mask++) {
      const s = d.reduce((a, x, i) => a + ((mask >> i) & 1 ? -x : x), 0)
      if (s >= observed - 1e-12) hits++
    }
    const exact = hits / 2 ** d.length
    expect(meanFlipP(d, 200_000, seeded(1))).toBeCloseTo(exact, 2)
  })

  it('is never below 1 / (1 + flips), so it cannot report more certainty than it drew', () => {
    expect(meanFlipP([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 999, seeded(2))).toBeGreaterThanOrEqual(1 / 1000)
  })

  it('holds its level on symmetric noise', () => {
    const rnd = seeded(3)
    let rejections = 0
    const trials = 400
    for (let t = 0; t < trials; t++) {
      const d = Array.from({ length: 60 }, () => (rnd() - 0.5) * 0.1)
      if (meanFlipP(d, 400, rnd) < 0.05) rejections++
    }
    expect(rejections / trials).toBeLessThan(0.09)
  })
})

describe('caseVerdict', () => {
  const S: VerdictSettings = { floorPct: 1, alphaMedian: 0.0005, alphaMean: 0.0005, flips: 20_000 }

  it('fails a uniform slowdown on the median test', () => {
    const rnd = seeded(4)
    const d = Array.from({ length: 150 }, () => Math.log(1.03) + (rnd() - 0.5) * 0.04)
    const v = caseVerdict(d, S, rnd)
    expect(v.failedMedian).toBe(true)
    expect(v.failed).toBe(true)
  })

  it('fails a slowdown that only some rounds carry on the mean test, which the median misses', () => {
    const rnd = seeded(5)
    // One round in five is 20% slower; the rest are identical apart from small noise.
    const d = Array.from({ length: 150 }, (_, i) => (i % 5 === 0 ? Math.log(1.2) : 0) + (rnd() - 0.5) * 0.004)
    const v = caseVerdict(d, S, rnd)
    expect(v.failedMedian).toBe(false)
    expect(v.failedMean).toBe(true)
    expect(v.failed).toBe(true)
  })

  it('passes identical code', () => {
    const rnd = seeded(6)
    const d = Array.from({ length: 150 }, () => (rnd() - 0.5) * 0.08)
    expect(caseVerdict(d, S, rnd).failed).toBe(false)
  })

  it('does not fail a significant change under the floor', () => {
    const rnd = seeded(7)
    const d = Array.from({ length: 300 }, () => Math.log(1.005) + (rnd() - 0.5) * 0.002)
    expect(caseVerdict(d, S, rnd).failed).toBe(false)
  })

  it('refuses empty or non-finite rounds', () => {
    expect(() => caseVerdict([], S, seeded(8))).toThrow('no rounds')
    expect(() => caseVerdict([0.01, Number.NaN], S, seeded(8))).toThrow('non-finite')
    expect(() => caseVerdict([0.01, Number.POSITIVE_INFINITY], S, seeded(8))).toThrow('non-finite')
  })
})

describe('mergeShards fails closed', () => {
  const cases = ['a/x', 'b/y']
  const roundsFor = (id: string): number => (id === 'a/x' ? 2 : 3)
  const shard = (seed: number, over: Record<string, unknown> = {}): { name: string; text: string } => ({
    name: `s${seed}.json`,
    text: JSON.stringify({
      reference: 'abc12345',
      seed,
      node: 'v26.13.0',
      logs: { 'a/x': [0.01, -0.01], 'b/y': [0, 0.02, -0.02] },
      minLogs: { 'a/x': [0.01, -0.01], 'b/y': [0, 0.02, -0.02] },
      ...over,
    }),
  })

  it('merges every round of every shard', () => {
    const m = mergeShards([shard(1), shard(2)], 2, 'abc12345', cases, roundsFor, '26')
    expect(m.logs.get('a/x')).toHaveLength(4)
    expect(m.logs.get('b/y')).toHaveLength(6)
    expect(m.seeds).toEqual([1, 2])
  })

  it('fails on a missing shard', () => {
    expect(() => mergeShards([shard(1)], 2, 'abc12345', cases, roundsFor, '26')).toThrow('expected 2 shard files, found 1')
  })

  it('fails on an extra shard, or with no expected count', () => {
    expect(() => mergeShards([shard(1), shard(2), shard(3)], 2, 'abc12345', cases, roundsFor, '26')).toThrow('found 3')
    expect(() => mergeShards([shard(1)], Number.NaN, 'abc12345', cases, roundsFor, '26')).toThrow('positive integer')
  })

  it('fails on a shard measured against another reference', () => {
    expect(() => mergeShards([shard(1, { reference: 'ffff0000' })], 1, 'abc12345', cases, roundsFor, '26')).toThrow('measured against ffff0000')
  })

  it('fails on the wrong number of rounds for a case', () => {
    const short = shard(1, { logs: { 'a/x': [0.01], 'b/y': [0, 0.02, -0.02] } })
    expect(() => mergeShards([short], 1, 'abc12345', cases, roundsFor, '26')).toThrow('has 1 rounds for a/x, expected 2')
    const missing = shard(1, { logs: { 'b/y': [0, 0.02, -0.02] } })
    expect(() => mergeShards([missing], 1, 'abc12345', cases, roundsFor, '26')).toThrow('has 0 rounds for a/x')
  })

  it('fails on null or non-finite values', () => {
    const nul = shard(1, { logs: { 'a/x': [0.01, null], 'b/y': [0, 0.02, -0.02] } })
    expect(() => mergeShards([nul], 1, 'abc12345', cases, roundsFor, '26')).toThrow('non-finite rounds value for a/x: null')
    const nan = shard(1, { minLogs: { 'a/x': [0.01, 'x'], 'b/y': [0, 0.02, -0.02] } })
    expect(() => mergeShards([nan], 1, 'abc12345', cases, roundsFor, '26')).toThrow('non-finite minima value for a/x')
  })

  it('fails on a shard from another node major, or one that does not say', () => {
    expect(() => mergeShards([shard(1), shard(2, { node: 'v24.22.1' })], 2, 'abc12345', cases, roundsFor, '26')).toThrow('ran on node v24.22.1, not node 26')
    expect(() => mergeShards([shard(1, { node: undefined })], 1, 'abc12345', cases, roundsFor, '26')).toThrow('does not record its node version')
    expect(() => mergeShards([shard(1)], 1, 'abc12345', cases, roundsFor, '24')).toThrow('not node 24')
  })

  it('fails when shards ran on two exact node versions, even of one major', () => {
    expect(() => mergeShards([shard(1), shard(2, { node: 'v26.13.1' })], 2, 'abc12345', cases, roundsFor, '26')).toThrow('one verdict, one runtime')
  })

  it('fails on corrupt JSON, a missing seed, or a repeated seed', () => {
    expect(() => mergeShards([{ name: 'bad.json', text: '{' }], 1, 'abc12345', cases, roundsFor, '26')).toThrow('bad.json is not JSON')
    expect(() => mergeShards([shard(1, { seed: undefined })], 1, 'abc12345', cases, roundsFor, '26')).toThrow('has no seed')
    expect(() => mergeShards([shard(1), shard(1)], 2, 'abc12345', cases, roundsFor, '26')).toThrow('repeats seed 1')
  })
})

describe('aggregateSeed', () => {
  it('depends on the set of shard seeds, not their order or the moment it runs', () => {
    expect(aggregateSeed([3, 1, 2])).toBe(aggregateSeed([1, 2, 3]))
    expect(aggregateSeed([1, 2, 3])).not.toBe(aggregateSeed([1, 2, 4]))
  })
})

describe('the committed shard count is the one CI runs', () => {
  it('matches every xproc-shard matrix in ci.yml', async () => {
    const { readFileSync } = await import('node:fs')
    const root = new URL('../../', import.meta.url)
    const config = JSON.parse(readFileSync(new URL('bench/xproc-gate.json', root), 'utf8')) as { shards: number }
    const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')
    const job = ci.slice(ci.indexOf('  xproc-shard:'), ci.indexOf('  xproc-perf:'))
    const list = /shard: \[([^\]]*)\]/.exec(job)?.[1]?.split(',').map(x => Number(x.trim()))
    expect(list).toEqual(Array.from({ length: config.shards }, (_, i) => i + 1))
    expect(ci).toContain(`--expect-shards=${config.shards}`)
  })
})

describe('verdict modes refuse flags that change what is measured', () => {
  it('names every forbidden flag present, bare or with a value', () => {
    expect(verdictModeArgErrors(['--shard-out=x.json', '--peak', '--seed=4'])).toEqual([])
    expect(verdictModeArgErrors(['--aggregate=d', '--expect-shards=20', '--rounds=2', '--case=json', '--suite=density']))
      .toEqual(['--rounds', '--case', '--suite'])
    expect(verdictModeArgErrors(['--shard-out=x', '--report-only', '--self', '--ref=abc', '--head-ref=def']))
      .toEqual(['--report-only', '--self', '--ref', '--head-ref'])
  })
})

describe('the committed node major is the one CI pins', () => {
  it('matches node-version in both xproc jobs', async () => {
    const { readFileSync } = await import('node:fs')
    const root = new URL('../../', import.meta.url)
    const config = JSON.parse(readFileSync(new URL('bench/xproc-gate.json', root), 'utf8')) as { node: number }
    const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')
    const jobs = ci.slice(ci.indexOf('  xproc-shard:'), ci.indexOf('  macro-perf:'))
    const pins = [...jobs.matchAll(/node-version: (\S+)/g)].map(m => m[1])
    expect(pins).toEqual([String(config.node), String(config.node)])
  })
})

describe('mode flags need their operand', () => {
  it('names a bare or empty --shard-out, --aggregate or --expect-shards', () => {
    expect(missingOperandFlags(['--shard-out=x.json', '--aggregate=d', '--expect-shards=20', '--peak'])).toEqual([])
    expect(missingOperandFlags(['--shard-out'])).toEqual(['--shard-out'])
    expect(missingOperandFlags(['--aggregate=', '--expect-shards'])).toEqual(['--aggregate', '--expect-shards'])
  })

  it('makes the gate exit before measuring', async () => {
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const gate = fileURLToPath(new URL('../../bench/xproc-gate.ts', import.meta.url))
    for (const flag of ['--shard-out', '--aggregate']) {
      const r = spawnSync(process.execPath, ['--import', 'tsx/esm', gate, flag], { encoding: 'utf8', timeout: 60_000 })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`${flag} needs a value`)
    }
  }, 120_000)
})

describe('the reference is resolved once per run', () => {
  // Tag commit times (unix seconds). HEAD (the run's commit) is made at 1000.
  const releases = [
    { tag: 'v0.58.2', sha: '617aab0e', date: 2000 },
    { tag: 'v0.58.1', sha: '80562d9b', date: 500 },
    { tag: 'v0.58.0', sha: 'eaa3d1a1', date: 100 },
  ]
  const HEAD = 1000

  it('accepts the previous release', () => {
    expect(pinnedReferenceError('617aab0e', releases, HEAD)).toBeNull()
    expect(pinnedReferenceError('617aab0e', releases, 3000)).toBeNull()
  })

  it('accepts the one before it only when the newest was tagged after the run\'s commit', () => {
    // v0.58.2 (2000) is newer than HEAD (1000): it arrived mid-run, so the pin is v0.58.1.
    expect(pinnedReferenceError('80562d9b', releases, HEAD)).toBeNull()
    expect(pinnedReferenceError('80562d9bf00', releases, HEAD)).toBeNull()
    // HEAD at 3000 already postdates v0.58.2: it was the previous release when the run
    // started, so pinning v0.58.1 is refused.
    expect(pinnedReferenceError('80562d9b', releases, 3000)).toMatch(/is v0\.58\.1, but v0\.58\.2 was tagged before this run's commit/)
    expect(pinnedReferenceError('80562d9b', releases, 2000)).toMatch(/was tagged before this run's commit/)
  })

  it('refuses an older release, an unknown sha, or a stub too short to identify one', () => {
    expect(pinnedReferenceError('eaa3d1a1', releases, HEAD)).toMatch(/not the previous release \(v0.58.2 617aab0e or v0.58.1 80562d9b\)/)
    expect(pinnedReferenceError('deadbeef', releases, HEAD)).toMatch(/not the previous release/)
    expect(pinnedReferenceError('617a', releases, HEAD)).toMatch(/not a commit sha/)
  })

  it('refuses revision syntax that would make git resolve something else', () => {
    for (const bad of ['80562d9b~5', '80562d9b^', '80562d9b^{commit}', 'v0.58.1', '80562D9B', ' 80562d9b']) {
      expect(pinnedReferenceError(bad, releases, HEAD)).toMatch(/not a commit sha/)
    }
  })

  it('--print-reference refuses any reference handed to it', () => {
    expect(printReferenceArgErrors(['--print-reference'])).toEqual([])
    expect(printReferenceArgErrors(['--print-reference', '--peak'])).toEqual([])
    expect(printReferenceArgErrors(['--print-reference', '--ref=047f920'])).toEqual(['--ref'])
    expect(printReferenceArgErrors(['--print-reference', '--reference=617aab0e', '--head-ref=x', '--self']))
      .toEqual(['--reference', '--head-ref', '--self'])
  })

  it('makes the gate exit when --print-reference is given --ref', async () => {
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const gate = fileURLToPath(new URL('../../bench/xproc-gate.ts', import.meta.url))
    const r = spawnSync(process.execPath, ['--import', 'tsx/esm', gate, '--print-reference', '--ref=047f920'], { encoding: 'utf8', timeout: 60_000 })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('--print-reference resolves the reference itself; it refuses --ref')
  }, 120_000)

  /**
   * The steps of one job in ci.yml: each step's `env:` map and its `run:` command. A
   * small parser for the shape this file uses, so the test reads the actual argument
   * each call receives rather than searching for a substring.
   */
  async function steps(job: string): Promise<Array<{ env: Record<string, string>; run: string }>> {
    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').split('\n')
    const start = lines.indexOf(`  ${job}:`)
    expect(start).toBeGreaterThan(-1)
    let end = lines.findIndex((l, i) => i > start && /^  [a-z-]+:$/.test(l))
    if (end === -1) end = lines.length
    const out: Array<{ env: Record<string, string>; run: string }> = []
    let cur: { env: Record<string, string>; run: string } | null = null
    let inEnv = false
    for (const line of lines.slice(start + 1, end)) {
      if (/^      - /.test(line)) { cur = { env: {}, run: '' }; out.push(cur); inEnv = false }
      if (cur === null) continue
      const key = /^(?:      - |        )([a-z-]+):\s?(.*)$/.exec(line)
      if (key !== null) {
        inEnv = key[1] === 'env' && key[2] === ''
        if (key[1] === 'run') cur.run = key[2]!
        continue
      }
      const env = /^          ([A-Z_]+): (.*)$/.exec(line)
      if (inEnv && env !== null) cur.env[env[1]!] = env[2]!
    }
    return out
  }

  /** The value of one `--flag=` argument in a shell command, with surrounding quotes removed. */
  const argOf = (run: string, flag: string): string[] =>
    [...run.matchAll(new RegExp(`(?:^|\\s)${flag}=("[^"]*"|\\S+)`, 'g'))].map(m => m[1]!.replace(/^"(.*)"$/, '$1'))

  it('resolves the reference once, in xproc-ref, for both targets', async () => {
    const runs = (await steps('xproc-ref')).map(s => s.run).filter(r => r.includes('perf:xproc:gate'))
    expect(runs).toEqual(['pnpm perf:xproc:gate --print-reference', 'pnpm perf:xproc:gate --peak --print-reference'])
  })

  it('hands every shard and the aggregate exactly that reference, through env, for both targets', async () => {
    for (const job of ['xproc-shard', 'xproc-perf']) {
      const gates = (await steps(job)).filter(s => s.run.includes('perf:xproc:gate'))
      expect(gates).toHaveLength(1)
      const { env, run } = gates[0]!
      // The argument is the env variable, never an interpolated expression...
      expect(argOf(run, '--reference')).toEqual(['$XPROC_REFERENCE'])
      expect(run).not.toContain('${{')
      // ...and the variable is the one job output, keyed by this job's target.
      expect(env['XPROC_REFERENCE']).toBe('${{ needs.xproc-ref.outputs[matrix.target] }}')
      expect(env['XPROC_TARGET']).toBe('${{ matrix.target }}')
    }
  })
})
