import { expect } from 'vitest'
import type { Combinator, CompiledParser, ParseContext, ParseResult } from '../../../src/types.ts'
import { makeRootLog, rowsOf } from '../../helpers/root-log.ts'
import type { RootTriviaLog } from '../../../src/cst/trivia-entries.ts'

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
 * The document's whole trivia log from a run's root rows (`rootTrivia: { select: 'all' }`),
 * in the `(start, end[, kindIndex])` form these checks read: an unlabelled gap is
 * `(start, end)`, a labelled chunk `(start, end, kindIndex)` into `labels`.
 */
export function triviaLogFromRootRows(rows: readonly number[], labels: readonly string[] = []): number[] {
  const out: number[] = []
  for (let i = 0; i < rows.length; i += 5) {
    const kind = rows[i + 4]!
    if (kind === labels.length) out.push(rows[i + 2]!, rows[i + 3]!)
    else out.push(rows[i + 2]!, rows[i + 3]!, kind)
  }
  return out
}

/** A context that records every trivia chunk in the document, as `run()` sets one up for
 * `rootTrivia: { select: 'all' }`: each label, then `''` for unlabelled trivia. */
function allTriviaContext(base: ParseContext, labels: readonly string[] = []): { ctx: ParseContext; rows: RootTriviaLog } {
  const rows = makeRootLog()
  rows.gapKind = labels.length
  const kinds: Record<string, number> = {}
  labels.forEach((label, i) => { kinds[label] ??= i })
  kinds[''] = labels.length
  return { ctx: { ...base, _rootTriviaLog: rows, _rootTriviaKindIndex: kinds }, rows }
}

/** Run interpreted + compiled, each recording the document's whole trivia log. */
export function runTriviaLogParity<T>(
  parser: Combinator<T>,
  compiled: CompiledParser<T>,
  input: string,
  baseCtx: ParseContext = { trackLines: false },
  labels: readonly string[] | undefined = baseCtx.triviaKindLabels,
): TriviaLogRun<T> {
  const i = allTriviaContext(baseCtx, labels)
  const k = allTriviaContext(baseCtx, labels)
  const interpreted = parser.parse(input, 0, i.ctx)
  const compiledResult = compiled.parseWithContext(input, k.ctx, 0)
  const iLog = triviaLogFromRootRows(rowsOf(i.rows), labels)
  const cLog = triviaLogFromRootRows(rowsOf(k.rows), labels)
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
  expect(iLog.length, 'no trivia was logged: the parity check would be vacuous').toBeGreaterThan(0)
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
