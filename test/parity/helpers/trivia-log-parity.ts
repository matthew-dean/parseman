import { expect } from 'vitest'
import type { Combinator, CompiledParser, ParseContext, ParseResult } from '../../../src/types.ts'

/** Flat [start, end, start, end, …] pairs from `_triviaLog`. */
export function triviaPairs(log: readonly number[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  for (let i = 0; i + 1 < log.length; i += 2) {
    pairs.push([log[i]!, log[i + 1]!])
  }
  return pairs
}

/** Fails when speculative trivia commits were not rolled back (duplicate spans). */
export function expectUniqueTriviaPairs(log: readonly number[]): void {
  expect(log.length % 2, '_triviaLog length must be even (start/end pairs)').toBe(0)
  const seen = new Set<string>()
  for (const [start, end] of triviaPairs(log)) {
    expect(end, `trivia end must follow start at ${start}`).toBeGreaterThan(start)
    const key = `${start},${end}`
    expect(seen.has(key), `duplicate trivia pair [${start}, ${end})`).toBe(false)
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
export function expectTriviaLogParity(iLog: readonly number[], cLog: readonly number[]): void {
  expectUniqueTriviaPairs(iLog)
  expectUniqueTriviaPairs(cLog)
  expect(cLog, 'compiled _triviaLog must match interpreted _triviaLog').toEqual([...iLog])
}

export function expectTriviaLogGolden(log: readonly number[], expected: readonly number[]): void {
  expectUniqueTriviaPairs(log)
  expect([...log], 'golden _triviaLog').toEqual([...expected])
}
