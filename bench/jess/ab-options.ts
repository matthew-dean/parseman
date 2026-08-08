import type { Measurement } from '../ab-harness.ts'

export type MeasurementField = 'warmup' | 'timed' | 'rounds' | 'runs'

export type MeasurementResolution = {
  measurement: Measurement
  overrides: string[]
}

const FIELDS: readonly MeasurementField[] = ['warmup', 'timed', 'rounds', 'runs']

/**
 * Resolve high-sample overrides without changing the committed routine defaults.
 * CLI wins over environment, which wins over `ab-config.json`.
 */
export function resolveMeasurement(
  base: Measurement,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): MeasurementResolution {
  const measurement = { ...base }
  const overrides: string[] = []
  for (const field of FIELDS) {
    const flag = `--${field}`
    const cli = argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1)
    const envName = `PM_JESS_AB_${field.toUpperCase()}`
    const raw = cli ?? env[envName]
    if (raw === undefined) continue
    const value = Number(raw)
    const minimum = field === 'warmup' ? 0 : 1
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${cli !== undefined ? flag : envName} must be an integer >= ${minimum}; got ${JSON.stringify(raw)}`)
    }
    measurement[field] = value
    overrides.push(`${field}=${value} (${cli !== undefined ? 'CLI' : envName})`)
  }
  return { measurement, overrides }
}

export type PairedRoundDispersion = {
  ratios: number[]
  min: number
  p10: number
  median: number
  p90: number
  max: number
  headWins: number
}

function quantile(sorted: readonly number[], p: number): number {
  const at = (sorted.length - 1) * p
  const lo = Math.floor(at), hi = Math.ceil(at)
  const a = sorted[lo]!, b = sorted[hi]!
  return a + (b - a) * (at - lo)
}

/**
 * Collapse each round's adjacent paired samples to one median HEAD/REF ratio,
 * then report the distribution across rounds. This exposes instability that a
 * single pooled median hides while preserving the harness's actual pairing.
 */
export function pairedRoundDispersion(
  refSamples: readonly number[],
  headSamples: readonly number[],
  runs: number,
): PairedRoundDispersion {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer; got ${runs}`)
  if (refSamples.length !== headSamples.length) {
    throw new Error(`paired sample lengths differ: ref=${refSamples.length}, head=${headSamples.length}`)
  }
  if (refSamples.length === 0 || refSamples.length % runs !== 0) {
    throw new Error(`paired sample count ${refSamples.length} is not a non-zero multiple of runs=${runs}`)
  }
  const ratios: number[] = []
  for (let start = 0; start < refSamples.length; start += runs) {
    const paired: number[] = []
    for (let i = start; i < start + runs; i++) {
      const ref = refSamples[i]!, head = headSamples[i]!
      if (!(ref > 0) || !(head >= 0)) throw new Error(`invalid paired sample at index ${i}: ref=${ref}, head=${head}`)
      paired.push(head / ref)
    }
    paired.sort((a, b) => a - b)
    ratios.push(quantile(paired, 0.5))
  }
  const sorted = [...ratios].sort((a, b) => a - b)
  return {
    ratios,
    min: sorted[0]!,
    p10: quantile(sorted, 0.1),
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    max: sorted.at(-1)!,
    headWins: ratios.filter(r => r < 1).length,
  }
}
