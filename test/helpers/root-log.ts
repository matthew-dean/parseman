import { RootTriviaLog, growRootTriviaLog } from '../../src/cst/trivia-entries.ts'

/** A context's root trivia log, holding `rows` (a test's seed rows, if any). */
export function makeRootLog(rows: readonly number[] = []): RootTriviaLog {
  const log = new RootTriviaLog()
  if (rows.length > log.buf.length) growRootTriviaLog(log, rows.length)
  for (let i = 0; i < rows.length; i++) log.buf[i] = rows[i]!
  log.length = rows.length
  return log
}

/** The numbers a root trivia log holds, as an array a test compares. */
export function rowsOf(log: RootTriviaLog | undefined): number[] {
  return log === undefined ? [] : [...log.buf.subarray(0, log.length)]
}

/** Append numbers to a root trivia log, as a leaking combinator a test plants would. */
export function pushRows(log: RootTriviaLog | undefined, ...values: number[]): void {
  if (log === undefined) return
  if (log.length + values.length > log.buf.length) growRootTriviaLog(log, values.length)
  for (const v of values) log.buf[log.length++] = v
}
