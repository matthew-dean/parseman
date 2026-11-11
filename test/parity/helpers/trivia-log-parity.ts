import { expect } from 'vitest'
import type { Combinator, CompiledParser, ParseContext, ParseResult } from '../../../src/types.ts'

/** Stride for flat trivia logs: 2 or 3 numbers per entry. */
export function triviaLogStride(log: readonly number[], labels?: readonly string[]): number {
  if (!labels) return 2
  if (log.length % 3 === 0) return 3
  return 2
}

/** Flat trivia entries from a `(start, end[, kindIndex])` log. */
export function triviaEntriesFromLog(
  log: readonly number[],
  labels?: readonly string[],
): Array<{ start: number; end: number; kindIndex?: number }> {
  const stride = triviaLogStride(log, labels)
  const out: Array<{ start: number; end: number; kindIndex?: number }> = []
  for (let i = 0; i + stride - 1 < log.length; i += stride) {
    const entry: { start: number; end: number; kindIndex?: number } = {
      start: log[i]!,
      end: log[i + 1]!,
    }
    if (stride === 3) {
      const kindIndex = log[i + 2]
      if (kindIndex !== undefined) entry.kindIndex = kindIndex
    }
    out.push(entry)
  }
  return out
}

/** Fails when speculative trivia commits were not rolled back (duplicate spans). */
export function expectUniqueTriviaEntries(
  log: readonly number[],
  labels?: readonly string[],
): void {
  const stride = triviaLogStride(log, labels)
  expect(log.length % stride, `trivia log length must be a multiple of ${stride}`).toBe(0)
  const seen = new Set<string>()
  for (const e of triviaEntriesFromLog(log, labels)) {
    expect(e.end, `trivia end must follow start at ${e.start}`).toBeGreaterThan(e.start)
    const key = `${e.start},${e.end}`
    expect(seen.has(key), `duplicate trivia entry [${e.start}, ${e.end})`).toBe(false)
    seen.add(key)
  }
}

export type TriviaLogRun<T> = {
  iLog: number[]
  cLog: number[]
  interpreted: ParseResult<T>
  compiled: ParseResult<T>
}

/**
 * Every trivia entry the parse handed to a node builder, as one source-ordered
 * `(start, end)` log, `(start, end, kindIndex)` with `labels`.
 *
 * Each committed trivia scan records into exactly one frame, the innermost open
 * `node()`, so the union of the per-node logs is every committed trivia span. A
 * speculative scan that was not rolled back appears twice. A builder exposes its
 * log as `tl` or `triviaLog`; every builder of a grammar measured here must.
 */
export function nodeTriviaLog(value: unknown, labels?: readonly string[]): number[] {
  const stride = labels ? 4 : 3
  const entries: number[][] = []
  const seen = new Set<object>()
  const walk = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    const o = v as { tl?: unknown; triviaLog?: unknown }
    const tl = o.tl ?? o.triviaLog
    if (Array.isArray(tl) && tl.every((n): n is number => typeof n === 'number')) {
      for (let i = 0; i + stride - 1 < tl.length; i += stride) {
        entries.push(labels ? [tl[i]!, tl[i + 1]!, tl[i + 3]!] : [tl[i]!, tl[i + 1]!])
      }
    }
    for (const x of Object.values(o)) if (x !== tl) walk(x)
  }
  walk(value)
  entries.sort((x, y) => x[0]! - y[0]!)
  return entries.flat()
}

/** Run interpreted + compiled with trivia capture on, and read each one's per-node trivia logs. */
export function runTriviaLogParity<T>(
  parser: Combinator<T>,
  compiled: CompiledParser<T>,
  input: string,
  baseCtx: ParseContext = { trackLines: false },
  labels: readonly string[] | undefined = baseCtx.triviaKindLabels,
): TriviaLogRun<T> {
  const interpreted = parser.parse(input, 0, { ...baseCtx, captureTrivia: true })
  const compiledResult = compiled.parseWithContext(input, { ...baseCtx, captureTrivia: true }, 0)
  const iLog = interpreted.ok ? nodeTriviaLog(interpreted.value, labels) : []
  const cLog = compiledResult.ok ? nodeTriviaLog(compiledResult.value, labels) : []
  return { iLog, cLog, interpreted, compiled: compiledResult }
}

/**
 * Core guard: interpreted and compiled must record identical trivia spans.
 * Catches out-of-sync rollback/codegen bugs in either direction.
 */
export function expectTriviaLogParity(
  iLog: readonly number[],
  cLog: readonly number[],
  labels?: readonly string[],
): void {
  expect(iLog.length, 'no trivia reached a node builder: the parity check would be vacuous').toBeGreaterThan(0)
  expectUniqueTriviaEntries(iLog, labels)
  expectUniqueTriviaEntries(cLog, labels)
  expect(cLog, 'compiled trivia log must match interpreted trivia log').toEqual([...iLog])
}

export function expectTriviaLogGolden(
  log: readonly number[],
  expected: readonly number[],
  labels?: readonly string[],
): void {
  expectUniqueTriviaEntries(log, labels)
  expect([...log], 'golden trivia log').toEqual([...expected])
}
