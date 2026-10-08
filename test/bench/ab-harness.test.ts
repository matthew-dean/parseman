import { execFileSync } from 'node:child_process'
import v8 from 'node:v8'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copySamples,
  interleave,
  measurePasses,
  pairedMedianDelta,
  pairedMedianRatio,
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
    expect(row.dMedianAggregateV1).toBeCloseTo(60)
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
    expect(row.dMedianAggregateV1).toBe(0)
    expect(row.dMin).toBe(0)
    expect(row.dMinAggregateV1).toBe(100)
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
const at = (rel: string): string => JSON.stringify(new URL(rel, import.meta.url).pathname)

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
      '--no-compilation-cache',
      'ref', 'head', 'ref', 'ref',
      'ref', 'ref', 'ref', 'head',
    ])
    expect(calibration.get('x')?.pairs).toBe(2)
  })
})
