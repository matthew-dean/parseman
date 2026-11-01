import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copySamples,
  interleave,
  measurePasses,
  pairedMedianDelta,
  mergeBaseNote,
  identicalSourceNote,
  sameSource,
  pairedMedianRatio,
  previousRelease,
  score,
  type Calibration,
  type Samples,
  type Thresholds,
} from '../../bench/ab-harness.ts'

afterEach(() => { vi.restoreAllMocks() })

const T: Thresholds = {
  medianPct: 5,
  minPct: 5,
  winRateCeiling: 0.5,
  signTest: { winRateCeiling: 0.5, medianPct: 5, minPct: 5 },
}

const K: Calibration = {
  wins: 0,
  pairs: 5,
  nullRate: 0.5,
  ceiling: 0.5,
  signCeiling: 0.5,
  worstNullMedian: 0,
}

function samples(ref: number[], head: number[], refMin = ref, headMin = head): Samples {
  const out = new Map<string, number[]>([['ref|drift', ref], ['head|drift', head]]) as Samples
  out.mins = new Map([['ref|drift', refMin], ['head|drift', headMin]])
  return out
}

describe('paired A/B scoring', () => {
  it('reduces aligned ratios instead of a ratio of drifted aggregates', () => {
    const ref = [20, 70, 21, 65, 25]
    const head = [25, 65, 21, 50, 40]

    // The retired formula says +60%; the aligned experiment's median is flat.
    expect(40 / 25).toBe(1.6)
    expect(pairedMedianRatio(ref, head)).toBe(1)
    expect(pairedMedianDelta(ref, head)).toBe(0)
    const row = score(['drift'], samples(ref, head), T, new Map([['drift', K]]))[0]!
    expect(row).toMatchObject({ dMedian: 0, breach: false })
  })

  it('pairs within-sample minima rather than unrelated global minima', () => {
    const ref = [10, 100, 100]
    const head = [20, 100, 100]
    const refMin = [1, 10, 10]
    const headMin = [2, 10, 10]
    const row = score(
      ['drift'],
      samples(ref, head, refMin, headMin),
      T,
      new Map([['drift', { ...K, pairs: 3 }]]),
    )[0]!
    expect(row.dMedian).toBe(0)
    expect(row.dMin).toBe(0)
    expect(Math.min(...head) / Math.min(...ref)).toBe(2)
    expect(Math.min(...headMin) / Math.min(...refMin)).toBe(2)
    expect(row.scorer).toBe('paired-ratio-v2')
  })

  it('preserves side and minimum alignment through interleave', () => {
    // Two rounds. Round 0 measures REF then HEAD; round 1 reverses them.
    // Each side has two timed repetitions, and these absolute clock readings
    // encode durations ref=[1,4]/head=[2,8], then head=[10,10]/ref=[5,5].
    const readings = [0, 1, 2, 6, 7, 9, 10, 18, 19, 29, 30, 40, 41, 46, 47, 52]
    vi.spyOn(performance, 'now').mockImplementation(() => readings.shift()!)
    const one = (id: string) => [{ id, detail: '', parse: () => null, run: () => {} }]
    const out = interleave(
      [{ label: 'pair', a: one('x'), b: one('x') }],
      new Map([['x', 1]]),
      { targetSampleMs: 0, warmup: 0, timed: 2, rounds: 2, runs: 1 },
    ).get('pair')!

    expect(out.get('ref|x')).toEqual([2.5, 5])
    expect(out.get('head|x')).toEqual([5, 10])
    expect(out.mins.get('ref|x')).toEqual([1, 5])
    expect(out.mins.get('head|x')).toEqual([2, 10])
    expect(pairedMedianRatio(out.get('ref|x')!, out.get('head|x')!)).toBe(2)
    expect(readings).toEqual([])
  })

  it('clones the median and minimum series together', () => {
    const original = samples([1, 2], [3, 4], [0.5, 1], [1.5, 2])
    const cloned = copySamples(original)
    cloned.get('ref|drift')!.push(9)
    cloned.mins.get('ref|drift')!.push(9)
    expect(original.get('ref|drift')).toEqual([1, 2])
    expect(original.mins.get('ref|drift')).toEqual([0.5, 1])
  })

  it('rejects unpaired and invalid series', () => {
    expect(() => pairedMedianRatio([1], [1, 2])).toThrow('paired sample lengths differ')
    expect(() => pairedMedianRatio([], [])).toThrow('must not be empty')
    expect(() => pairedMedianRatio([0], [1])).toThrow('invalid paired sample')
  })
})

/**
 * Optimize the middle of three `new Function` instances over one source text and
 * report which of the three are optimized afterwards. An instance that comes back
 * optimized without being asked shares its feedback vector and code with the one
 * that was — the compilation-cache sharing `isolateCompilation` exists to remove.
 */
function optimizedAfterOptimizingOne(isolate: boolean): boolean[] {
  const script = `
    import { isolateCompilation } from ${at('../../bench/ab-harness.ts')};
    const make = () => new Function('return function f(x) { let s = 0; for (let i = 0; i < x; i++) s += i; return s }')();
    make(); make();
    ${isolate ? 'isolateCompilation();' : ''}
    const fs = [make(), make(), make()];
    for (const f of fs) { %PrepareFunctionForOptimization(f); f(3); }
    %OptimizeFunctionOnNextCall(fs[1]); fs[1](3);
    for (const f of fs) f(3);
    console.log(JSON.stringify(fs.map(f => (%GetOptimizationStatus(f) & 16) !== 0)));
  `
  return nodeModule(script, ['--allow-natives-syntax']) as boolean[]
}

/** A repo file as a quoted absolute path, for a script run by `nodeModule`. */
const at = (rel: string): string => JSON.stringify(fileURLToPath(new URL(rel, import.meta.url)))

/** Run `script` as an ES module under real node + tsx (vitest's own loader is not node's). */
function nodeModule(script: string, flags: string[] = []): unknown {
  const out = execFileSync(
    process.execPath,
    [...flags, '--import', 'tsx/esm', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  )
  return JSON.parse(out.trim().split('\n').pop()!)
}

describe('every timed instance is its own compile, from its own module graph', () => {
  it('gives every identical new Function its own compiled code once isolated', () => {
    // The probe can see the sharing: with the cache on, optimizing one instance
    // optimizes its byte-identical twins, because they are one compiled object.
    expect(optimizedAfterOptimizingOne(false)).toEqual([true, true, true])
    expect(optimizedAfterOptimizingOne(true)).toEqual([false, true, false])
  }, 30_000)

  it('allocates every instance young once isolated, so pretenuring cannot pick a side', () => {
    // A literal whose allocations all survive two scavenges is pretenured: its
    // re-optimized function allocates straight into old space.
    const youngAfterSurvivingGcs = (isolate: boolean): boolean => nodeModule(`
      import { isolateCompilation } from ${at('../../bench/ab-harness.ts')};
      ${isolate ? 'isolateCompilation();' : ''}
      function make() { return { a: [1, 2, 3], b: { c: 1 } } }
      %PrepareFunctionForOptimization(make);
      const keep = [];
      for (let r = 0; r < 4; r++) { for (let i = 0; i < 50000; i++) keep.push(make()); gc({ type: 'minor' }); }
      %OptimizeFunctionOnNextCall(make); make();
      console.log(JSON.stringify(%InYoungGeneration(make())));
    `, ['--allow-natives-syntax', '--expose-gc']) as boolean
    expect(youngAfterSurvivingGcs(false)).toBe(false)
    expect(youngAfterSurvivingGcs(true)).toBe(true)
  }, 30_000)

  it('imports each freshGraph as a whole module graph of its own', () => {
    const [sameGraph, otherGraph] = nodeModule(`
      import { freshGraph } from ${at('../../bench/ab-harness.ts')};
      const one = freshGraph(), two = freshGraph();
      const entry = await one(${at('../../src/index.ts')});
      const deep = await one(${at('../../src/table/compile.ts')});
      const other = await two(${at('../../src/index.ts')});
      console.log(JSON.stringify([entry.compile === deep.compile, entry.compile === other.compile]));
    `) as boolean[]
    // A module reached transitively from one graph's entry is that graph's own…
    expect(sameGraph).toBe(true)
    // …and is not shared with any other graph, so neither are its helpers' JIT state.
    expect(otherGraph).toBe(false)
  }, 30_000)

  it('isolates compilation before building anything, and builds every contest side fresh', async () => {
    const log: string[] = []
    vi.spyOn(v8, 'setFlagsFromString').mockImplementation(flag => { log.push(flag) })
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock++)
    const side = (label: string) => async () => {
      log.push(label)
      return [{ id: 'x', detail: '', parse: () => null, run: () => {} }]
    }
    const { calibration } = await measurePasses(
      side('ref'), side('head'),
      new Map([['x', 1]]),
      { targetSampleMs: 0, warmup: 0, timed: 1, rounds: 1, runs: 1, passes: 2 },
      T,
    )
    // Pass 0 builds the gate pair first, pass 1 the null pair first; every side
    // of every contest is its own factory call, i.e. its own graph and compile.
    expect(log).toEqual([
      '--no-compilation-cache', '--no-allocation-site-pretenuring',
      'ref', 'head', 'ref', 'ref',
      'ref', 'ref', 'ref', 'head',
    ])
    expect(calibration.get('x')?.pairs).toBe(2)
  })
})

describe('the previous release is resolved from the v* tags', () => {
  /*
   * main: A(v0.1.0) ── B ── C
   *                     └── R(v0.1.1)   a release commit beside main, first parent B
   *       B ── X(v0.2.0)                a tag on a branch main never merged: not a
   *                                     release commit, so its parent does not count
   */
  function history(): { dir: string; at: (name: string) => string; checkout: (name: string) => void } {
    const dir = mkdtempSync(join(tmpdir(), 'pm-prev-release-'))
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
          GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
        },
      }).trim()
    const commit = (name: string, message = name): string => {
      writeFileSync(join(dir, 'f'), name)
      git('add', '-A')
      git('commit', '-qm', message)
      return git('rev-parse', 'HEAD')
    }
    const shas = new Map<string, string>()
    git('init', '-q', '-b', 'main')
    shas.set('A', commit('A'))
    git('tag', 'v0.1.0')
    shas.set('B', commit('B'))
    git('checkout', '-q', '-b', 'side')
    shas.set('X', commit('X'))
    git('tag', 'v0.2.0')
    git('checkout', '-q', '--detach', shas.get('B')!)
    shas.set('R', commit('R', 'release: 0.1.1'))
    git('tag', 'v0.1.1')
    git('checkout', '-q', 'main')
    shas.set('C', commit('C'))
    return {
      dir,
      at: name => shas.get(name)!.slice(0, 8),
      checkout: name => { git('checkout', '-q', '--detach', shas.get(name)!) },
    }
  }

  it('takes the newest release HEAD contains, including one tagged beside main', () => {
    const h = history()
    try {
      expect(previousRelease(h.dir, 'test')).toEqual({ tag: 'v0.1.1', sha: h.at('R') })
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  it("skips HEAD's own release: at B, the release made from B is not the previous one", () => {
    const h = history()
    try {
      h.checkout('B')
      expect(previousRelease(h.dir, 'test')).toEqual({ tag: 'v0.1.0', sha: h.at('A') })
      h.checkout('A')
      // A tag ON HEAD is HEAD's own release too; with nothing older there is no reference.
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(() => previousRelease(h.dir, 'test')).toThrow('exit')
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('the merge-base arm is measured only when nothing already answers it', () => {
  it('skips a PR that leaves src/ alone, reuses the release table when the base IS the release, else measures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-merge-base-'))
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' }).trim()
    const commit = (file: string, body: string): string => {
      execFileSync('mkdir', ['-p', join(dir, 'src')])
      writeFileSync(join(dir, file), body)
      git('add', '-A')
      git('commit', '-qm', file)
      return git('rev-parse', 'HEAD')
    }
    try {
      git('init', '-q', '-b', 'main')
      commit('src/version.ts', "export const PARSEMAN_VERSION = '0.1.0'")
      const release = commit('src/a.ts', '1')
      // The release commit stamps only src/version.ts, which does not count.
      const base = commit('src/version.ts', "export const PARSEMAN_VERSION = '0.1.1'")
      commit('docs.md', 'x')
      expect(mergeBaseNote(dir, base, release)).toMatch(/changes nothing under `src\/`/)
      commit('src/a.ts', '2')
      expect(mergeBaseNote(dir, base, release)).toMatch(/table above is also this PR against its base/)
      expect(mergeBaseNote(dir, base, base)).toMatch(/table above/)
      const older = git('rev-list', '--max-parents=0', 'HEAD')
      commit('src/b.ts', 'x')
      const newBase = git('rev-parse', 'HEAD~1')
      expect(mergeBaseNote(dir, newBase, older)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a gate whose two sides have the same src/ reports and does not fail', () => {
  it('compares src/ only, with the version stamp aside', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-same-src-'))
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' }).trim()
    const commit = (file: string, body: string): string => {
      execFileSync('mkdir', ['-p', join(dir, 'src')])
      writeFileSync(join(dir, file), body)
      git('add', '-A')
      git('commit', '-qm', file)
      return git('rev-parse', 'HEAD')
    }
    try {
      git('init', '-q', '-b', 'main')
      commit('src/version.ts', "export const PARSEMAN_VERSION = '0.1.0'")
      const release = commit('src/a.ts', '1')
      commit('src/version.ts', "export const PARSEMAN_VERSION = '0.1.1'")
      const ci = commit('ci.yml', 'x')
      expect(sameSource(dir, release, ci)).toBe(true)
      // The working tree, which a run without --head-ref measures, is compared as it stands.
      expect(sameSource(dir, release, null)).toBe(true)
      writeFileSync(join(dir, 'src/a.ts'), '2')
      expect(sameSource(dir, release, null)).toBe(false)
      writeFileSync(join(dir, 'src/a.ts'), '1')
      writeFileSync(join(dir, 'src/b.ts'), 'new')
      expect(sameSource(dir, release, null)).toBe(false)
      rmSync(join(dir, 'src/b.ts'))
      // Only the version literal is aside: code added to src/version.ts is a src/ change.
      expect(sameSource(dir, release, commit('src/version.ts', "export const PARSEMAN_VERSION = '0.1.1'\nexport const slow = 1"))).toBe(false)
      expect(sameSource(dir, release, commit('src/a.ts', '2'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says why, and names what breached as the noise floor', () => {
    expect(identicalSourceNote('g', 'v0.1.0', [])).toMatch(/A\/A control and gates nothing\. No case breached\./)
    expect(identicalSourceNote('g', 'v0.1.0', ['json/document'])).toMatch(/breached on json\/document: that is the noise floor/)
  })

  it.each(['grammar-perf-guard.ts', 'workload-perf-guard.ts'])('%s exits before its verdict when the sides are identical', (file) => {
    const src = readFileSync(fileURLToPath(new URL(`../../bench/${file}`, import.meta.url)), 'utf8')
    expect(src).toMatch(/const IDENTICAL = !SELF && sameSource\(ROOT, REF, HEAD_REF\)/)
    const exit = src.indexOf('if (IDENTICAL) {')
    expect(exit).toBeGreaterThan(-1)
    expect(exit).toBeLessThan(src.indexOf('const failures = rows.filter(v => v.failed)'))
    expect(src).toMatch(/!REPORT_ONLY && !SELF && !QUICK && !IDENTICAL/)
  })
})
