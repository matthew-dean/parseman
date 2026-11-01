/**
 * DIRECT VALUES ON REJECTED INPUT: the same failure, at the same position, with
 * the same expected set.
 *
 * Direct values change how children travel, not how a parse fails, and this is
 * the check that it stays so. Every accepted input of every suite in
 * `table-direct-values-cases.ts` is cut at prefix lengths and has characters
 * deleted, and every variant is parsed from every rule of the grammar through
 * every leg (direct, direct beside closures, the collector protocol, the closure
 * engine). The four must report the identical outcome: `ok`, the span, the
 * expected set in order, and where unconsumed input begins.
 *
 * `pnpm check:differentials` plants a moved failure position in the direct
 * node frame and requires this file to go red.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { run } from '../../src/functional/run.ts'
import { SUITES, legs } from './table-direct-values-cases.ts'

/** Every prefix and every one-character deletion, sampled to about 60 cut points. */
function variants(input: string): string[] {
  const out = new Set<string>()
  const step = Math.max(1, Math.ceil(input.length / 60))
  for (let i = 0; i < input.length; i += step) {
    out.add(input.slice(0, i))
    out.add(input.slice(0, i) + input.slice(i + 1))
  }
  return [...out]
}

describe('direct values report the same failure as every other engine', () => {
  // A `sepBy` of no minimum matches the empty list anywhere: nothing it is given
  // fails, so those two suites have no failure to compare.
  for (const { name, grammar, entry, cases, opts = {} } of SUITES.filter(s => !s.name.endsWith(' separator'))) {
    it(name, () => {
      // Every rule of the grammar is an entry: a root that is a repetition
      // succeeds on a prefix, so the failures worth comparing are its parts'.
      const prog = encodeTable(grammar)
      const entries = [entry, ...Object.keys(prog.rules).filter(r => r !== entry)]
      const texts = [...new Set(cases.flatMap(({ input }) => variants(input)))]
      let rejected = 0
      for (const rule of entries) {
        const es = legs(prog, rule)
        for (const text of texts) {
          const want = run(es.closure as never, text, opts)
          if (!want.ok) rejected++
          const failure = (r: typeof want): unknown => [r.ok, r.span, r.expected, r.unconsumedFrom]
          for (const [leg, piece] of Object.entries(es)) {
            expect(failure(run(piece as never, text, opts)), `${rule} ${JSON.stringify(text)}: ${leg}`).toEqual(failure(want))
          }
        }
      }
      // A differential over no rejected input compares nothing.
      expect(rejected, `${name}: rejected variants`).toBeGreaterThan(0)
    }, 60_000)
  }
})
