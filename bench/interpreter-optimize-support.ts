import { execFileSync } from 'node:child_process'
import { BAR_MARKER, CHART_GROUPS, type ChartKey } from './chart-specs.ts'

export const INTERPRETER_BROWSER_RAW_LIMIT = 58_014
export const INTERPRETER_AA_NOISE_LIMIT = 1.10
const CHILD_TIMEOUT_MS = 180_000

export function contextualizeInterpreterTimeout(error: unknown, leg: string): unknown {
  return error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT'
    ? new Error(`${leg} timed out after ${CHILD_TIMEOUT_MS} ms`, { cause: error })
    : error
}

/** Run one published-chart leg and fail with the exact leg when its child times out. */
export function measureInterpreterBar(
  root: string,
  child: string,
  chart: ChartKey,
  key: string,
): number[] {
  let out: string
  try {
    out = execFileSync(process.execPath, ['--import', 'tsx/esm', child, chart, key], {
      cwd: root,
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw contextualizeInterpreterTimeout(error, `${chart}/${key}`)
  }
  const line = out.split('\n').find(value => value.startsWith(BAR_MARKER))
  if (!line) throw new Error(`${chart}/${key} produced no ${BAR_MARKER} line`)
  const values = JSON.parse(line.slice(BAR_MARKER.length)) as unknown
  if (!Array.isArray(values) || values.length !== CHART_GROUPS[chart].length
      || values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${chart}/${key} produced unusable timings ${JSON.stringify(values)}`)
  }
  return values as number[]
}

/** Turn a measured harness invariant into a real process failure. */
export function assertInterpreterChecks(checks: ReadonlyArray<readonly [boolean, string]>): void {
  const failed = checks.filter(([ok]) => !ok).map(([, message]) => message)
  if (failed.length > 0) throw new Error(`interpreter optimization assertions failed:\n- ${failed.join('\n- ')}`)
}
