/**
 * G20 NORMALISATION — a `choice` of keyword arms compiles to one keyword table.
 *
 * `word(s)` is defined as `keywords([s], { boundary })`, so `choice(word('a'),
 * word('b'), …)` and `keywords(['a','b'], { boundary })` are the same dispatch
 * table spelled two ways. They used to compile to wildly different artifacts
 * (30 arms: 65,869 B vs 34,664 B, 1.90x) while doing identical matching work.
 *
 * These tests pin BOTH halves of the normalisation, and the declines matter more
 * than the merge: a merge that quietly fires where it must not would trade
 * dispatch for bytes, drop a runtime gate, or rewrite a diagnostic — all of
 * which a byte count would happily report as an improvement.
 */
import { describe, it, expect } from 'vitest'
import { word, keywords, choice, literal, regex, sequence, compile, parse } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'

/** The emitted source of a one-rule grammar, for shape assertions. */
function emit(root: Combinator<unknown>): string {
  return compile(root, undefined, { hostMode: 'ast' }).source
}

/** How many separate keyword-table blocks the emitter produced. */
function kwBlocks(code: string): number {
  return (code.match(/_kwLbl\d+:/g) ?? []).length
}

/**
 * Words are deliberately NOT first-char disjoint — they share leading letters —
 * so the choice falls to ordered first-match and the merge is allowed to fire.
 */
const SHARED_FIRST = ['amber', 'azure', 'beige', 'black', 'brown']
const BOUNDARY = '_0-9A-Za-z'

const armForm = choice(
  word(SHARED_FIRST[0]!, BOUNDARY),
  word(SHARED_FIRST[1]!, BOUNDARY),
  word(SHARED_FIRST[2]!, BOUNDARY),
  word(SHARED_FIRST[3]!, BOUNDARY),
  word(SHARED_FIRST[4]!, BOUNDARY),
)
const tableForm = keywords(SHARED_FIRST, { boundary: BOUNDARY })

describe('choice of keyword arms merges into one table', () => {
  it('emits ONE keyword block, not one per arm', () => {
    expect(kwBlocks(emit(armForm))).toBe(1)
  })

  it('compiles to within 10% of the equivalent keywords() table', () => {
    const arms = emit(armForm).length
    const table = emit(tableForm).length
    expect(Math.max(arms, table) / Math.min(arms, table)).toBeLessThan(1.1)
  })

  it('accepts and rejects exactly what the interpreter does', () => {
    const compiled = compile(armForm, undefined, { hostMode: 'ast' })
    const built = compiled.parse.bind(compiled)
    for (const input of [...SHARED_FIRST, 'amberish', 'amber-x', 'amber_1', 'zzz', '', 'amb', 'AMBER']) {
      const i = parse(armForm, input)
      const c = built(input)
      expect({ input, ok: c.ok, end: c.span.end, value: c.ok ? c.value : undefined })
        .toEqual({ input, ok: i.ok, end: i.span.end, value: i.ok ? i.value : undefined })
    }
  })

  /**
   * ORDER IS THE SEMANTICS. `keywords()` sorts longest-first at construction;
   * `choice()` is ordered first-match. The merge emits tries in ARM order, so a
   * prefix pair must still resolve the way the CHOICE resolves it — a merge that
   * re-sorted would silently make the longer word win.
   */
  it('keeps ordered first-match on a prefix pair instead of going longest-first', () => {
    // No boundary, so both arms really can match at the same position.
    const shortFirst = choice(keywords(['do']), keywords(['double']))
    const compiled = compile(shortFirst, undefined, { hostMode: 'ast' })
    const r = compiled.parse('double')
    expect(r.ok && r.value).toBe('do')
    const i = parse(shortFirst, 'double')
    expect(i.ok && i.value).toBe('do')
  })

  /**
   * The `expected` payload is the choice's own, NOT the single "keyword" label a
   * merged table would report. The spelling gate measured these differing (1
   * label vs N on a boundary rejection), so adopting the table's payload would
   * be a diagnostic regression invisible to any accepted-input tree comparison.
   */
  it('preserves the choice\'s own expected labels on failure', () => {
    const compiled = compile(armForm, undefined, { hostMode: 'ast' })
    const r = compiled.parse('zzz')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.expected.length).toBeGreaterThan(1)
  })
})

describe('the merge declines where it would cost something', () => {
  /**
   * THE IMPORTANT ONE. A first-char-disjoint choice compiles to O(1) dispatch;
   * collapsing it into one ordered scan would buy bytes with runtime. Distinct
   * first characters, so the choice IS disjoint.
   */
  it('declines on a disjoint choice, keeping first-char dispatch', () => {
    const disjoint = choice(word('alpha'), word('bravo'), word('charlie'), word('delta'))
    const code = emit(disjoint)
    expect(kwBlocks(code)).toBe(4)
    expect(code).toMatch(/switch \(|else if \(/)
  })

  it('declines when an arm carries a runtime gate', () => {
    const gated = choice(
      { gate: () => true, combinator: word('amber', BOUNDARY) },
      word('azure', BOUNDARY),
      word('beige', BOUNDARY),
    )
    expect(kwBlocks(emit(gated))).toBeGreaterThan(1)
  })

  it('declines when any arm is not a keyword', () => {
    const mixed = choice(word('amber', BOUNDARY), word('azure', BOUNDARY), regex(/[a-z]+/))
    // Declining means each keyword arm keeps its OWN block — two arms, two blocks.
    // (Merging them pairwise around the regex would reorder the arms.)
    expect(kwBlocks(emit(mixed))).toBe(2)
  })

  it('leaves a single-arm choice alone', () => {
    expect(kwBlocks(emit(choice(word('amber', BOUNDARY))))).toBe(1)
  })

  /**
   * A `literal()` arm has no boundary guard and a keyword arm does. They are not
   * the same parser, and the merge must not treat them as interchangeable.
   */
  it('declines on literal arms mixed with keyword arms', () => {
    const mixed = choice(word('amber', BOUNDARY), literal('azure'), word('beige', BOUNDARY))
    const compiled = compile(mixed, undefined, { hostMode: 'ast' })
    // `azure` has no boundary, so it must still match inside `azures`.
    expect(compiled.parse('azures').ok).toBe(true)
    expect(compiled.parse('ambers').ok).toBe(false)
  })
})

describe('merged arms still compose inside a larger grammar', () => {
  it('parses as a sequence term', () => {
    const compiled = compile(sequence(literal('@'), armForm), undefined, { hostMode: 'ast' })
    expect(compiled.parse('@beige').ok).toBe(true)
    expect(compiled.parse('@beigeish').ok).toBe(false)
    expect(compiled.parse('@zzz').ok).toBe(false)
  })
})
