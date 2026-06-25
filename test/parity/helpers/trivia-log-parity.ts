import { expect } from 'vitest'
import type { Combinator, CompiledParser, ParseContext, ParseResult } from '../../../src/types.ts'

/** Stride for flat trivia logs: 2 or 3 numbers per entry. */
export function triviaLogStride(log: readonly number[], labels?: readonly string[]): number {
  if (!labels) return 2
  if (log.length % 3 === 0) return 3
  return 2
}

/** Flat trivia entries from `_triviaLog`. */
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
    if (stride === 3) entry.kindIndex = log[i + 2]
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
  expect(log.length % stride, `_triviaLog length must be a multiple of ${stride}`).toBe(0)
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

/** Run interpreted + compiled with isolated `_triviaLog` buffers. */
export function runTriviaLogParity<T>(
  parser: Combinator<T>,
  compiled: CompiledParser<T>,
  input: string,
  baseCtx: ParseContext = { trackLines: false },
): TriviaLogRun<T> {
  const iLog: number[] = []
  const cLog: number[] = []
  const interpreted = parser.parse(input, 0, { ...baseCtx, _triviaLog: iLog })
  const compiledResult = compiled.parseWithContext(input, { ...baseCtx, _triviaLog: cLog }, 0)
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
  expectUniqueTriviaEntries(iLog, labels)
  expectUniqueTriviaEntries(cLog, labels)
  expect(cLog, 'compiled _triviaLog must match interpreted _triviaLog').toEqual([...iLog])
}

export function expectTriviaLogGolden(
  log: readonly number[],
  expected: readonly number[],
  labels?: readonly string[],
): void {
  expectUniqueTriviaEntries(log, labels)
  expect([...log], 'golden _triviaLog').toEqual([...expected])
}

/** @deprecated use triviaEntriesFromLog */
export function triviaPairs(log: readonly number[]): Array<[number, number]> {
  return triviaEntriesFromLog(log).map(e => [e.start, e.end])
}

/** @deprecated use expectUniqueTriviaEntries */
export function expectUniqueTriviaPairs(log: readonly number[]): void {
  expectUniqueTriviaEntries(log)
}
