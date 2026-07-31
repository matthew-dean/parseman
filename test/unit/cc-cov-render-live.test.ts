/**
 * The renderer over a report the ANALYSER actually produced.
 *
 * `cc-cov-render.test.ts` builds literal reports, which is what lets it assert the
 * exact bytes of every branch. That deliberately never runs the analyser — so it
 * cannot catch the one failure the two modules can have BETWEEN them: a report shape
 * the renderer reads differently from the way `profileWastedWork` writes it. A field
 * renamed on one side and defaulted on the other passes every literal-report test and
 * prints a zero here.
 *
 * So this file measures a grammar whose answer is known by construction, and asserts
 * that the printed numbers are the measured ones.
 */
import { describe, it, expect } from 'vitest'
import { choice, sequence, literal, regex, many, rules } from '../../src/index.ts'
import { analyzeChoiceInventory, profileWastedWork } from '../../src/analysis/choice-cost.ts'
import { renderChoiceInventory, renderWastedWork } from '../../src/analysis/choice-cost-render.ts'
import type { Combinator } from '../../src/types.ts'

/** Arm 0 demands a `!` the corpus never contains, so it fails after exactly 11 bytes
 *  (`<<<` plus eight digits) on every one of the 7 items: 77 bytes, by construction. */
const g = rules(() => ({
  Doc: many(choice(
    sequence(literal('<<<'), regex(/[0-9]{8}/), literal('!')),
    sequence(literal('<<<'), regex(/[0-9]{8}/), literal('?')),
  )),
}))
const entries = Object.entries(g) as [string, Combinator<unknown>][]

describe('renderWastedWork over a measured report', () => {
  const r = profileWastedWork({
    rules: entries, entry: 'Doc', corpus: [{ id: 'c', text: '<<<12345678?'.repeat(7) }],
  })

  it('measures the number the calibration predicts', () => {
    expect(r.totalGatedWastedBytes).toBe(77)
    expect(r.corpusBytes).toBe(84)
  })

  it('prints the measured numbers rather than re-deriving them', () => {
    const lines = renderWastedWork(r).split('\n')
    expect(lines[0]).toBe('wasted work — input bytes re-scanned after a failed alternative')
    expect(lines[5]).toBe('  corpus: 1 files, 84 B (1 parsed, 0 failed)')
    expect(lines[7]).toBe('  total:  77 B re-scanned — 0.92x the corpus')
    // The site, then the always-failing arm with its exact cost, then the arm that
    // matched every time and cost nothing.
    expect(lines.slice(12, 15)).toEqual([
      '  Doc › many       77 B  100.0%',
      '     0  "<<<"                          failed ALL 7                             77 B',
      '     1  "<<<"                          matched 7                          ',
    ])
    // …and the same arm again in the inversion ranking, which is what makes it a
    // finding rather than one more row in a table.
    expect(lines.at(-1)).toBe('    Doc › many arm  0  "<<<"                             7 entries        77 B')
  })

  it('renders the same bytes twice — the rendering is as diffable as the report', () => {
    expect(renderWastedWork(r)).toBe(renderWastedWork(r))
    expect(renderWastedWork(r)).not.toContain('undefined')
    expect(renderWastedWork(r)).not.toContain('NaN')
  })
})

describe('renderChoiceInventory over a measured inventory', () => {
  it('reports the compiler\'s own verdict — this site WAS left-factored', () => {
    const inv = analyzeChoiceInventory(entries)
    expect(inv.entries.some(e => e.factored)).toBe(true)
    expect(inv.backlogSites).toBe(0)
    const out = renderChoiceInventory(inv).split('\n')
    expect(out[3]).toBe(`  ${inv.rules} rules, ${inv.choiceSites} choice sites`)
    expect(out[4]).toBe(`  ${inv.factoredSites} left-factored by the compiler`)
    expect(out.at(-1)).toBe('  no declined shared prefixes.')
  })

  it('lists a DECLINED site once the arms stop sharing a lead', () => {
    const mixed = rules(() => ({
      Doc: many(choice(
        sequence(literal('@'), literal('media')),
        sequence(literal('@'), literal('layer')),
        sequence(regex(/[a-z]+/), literal(':')),
      )),
    }))
    const inv = analyzeChoiceInventory(Object.entries(mixed) as [string, Combinator<unknown>][])
    const out = renderChoiceInventory(inv)
    expect(inv.backlogSites).toBe(1)
    expect(out).toContain('  1 sites where alternatives share a leading term and the compiler DECLINED (2 arms)')
    expect(out).toContain('    arms 0, 1 all begin with "@"')
    expect(out).toContain('    declined: the arms do not all begin with the same term')
    // A partial group offers no rewrite: which arms move is the author's decision.
    expect(out).not.toContain('candidate rewrite')
  })
})
