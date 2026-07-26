/**
 * Dispatch-vs-choice proof fixture.
 *
 * Normal `pnpm test` checks that the A/B grammars are equivalent and exercise
 * the intended paths. Timing stays opt-in (`PARSEMAN_PERF=1 pnpm test:perf`) so
 * noisy machines do not turn a documentation/evidence fixture into a hard gate.
 */
import { describe, expect, it } from 'vitest'
import { buildDispatchChoiceCases, runDispatchChoiceAb } from '../../bench/dispatch-vs-choice.ts'

const describePerf = process.env.PARSEMAN_PERF === '1' ? describe : describe.skip

describe('dispatch vs choice A/B — validity & correctness', () => {
  const cases = buildDispatchChoiceCases(120)

  it('choice has the shared-opener gating warning while dispatch stays clean', () => {
    for (const c of cases) {
      expect(c.valid, c.name).toBe(true)
      expect(c.choiceWarnings.join('\n'), c.name).toContain('UNGATED')
      expect(c.dispatchWarnings, c.name).toEqual([])
    }
  })

  it('both grammars return identical values on representative inputs', () => {
    for (const c of cases) {
      for (const input of [...c.examples, c.input]) {
        const choice = c.choiceParser(input)
        const dispatch = c.dispatchParser(input)
        expect(choice.ok, `${c.name} choice: ${input}`).toBe(true)
        expect(dispatch.ok, `${c.name} dispatch: ${input}`).toBe(true)
        expect(choice.span.end, `${c.name} choice full parse: ${input}`).toBe(input.length)
        expect(dispatch.span.end, `${c.name} dispatch full parse: ${input}`).toBe(input.length)
        expect(dispatch, `${c.name}: ${input}`).toEqual(choice)
      }
    }
  })
})

describePerf('dispatch vs choice A/B — perf evidence', () => {
  it('dispatch wins the adversarial shared-opener workload by a noise-aware margin', () => {
    const results = runDispatchChoiceAb()
    for (const r of results) {
      console.log(`  ${r.name}: choice ${r.choiceUs.toFixed(2)}µs dispatch ${r.dispatchUs.toFixed(2)}µs ${r.speedup.toFixed(2)}x`)
      expect(r.valid, r.name).toBe(true)
      expect(r.ok, r.name).toBe(true)
      expect(r.speedup, r.name).toBeGreaterThan(1.25)
    }
  }, 60_000)
})
