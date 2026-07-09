import { describe, it, expect } from 'vitest'
import {
  rules, trivia, sequence, literal, oneOrMore, regex, compile, run, parser, noTrivia,
} from '../../src/index.ts'

const rw = trivia(oneOrMore(regex(/[ \t\n]+/)))

// Trivia declared ONCE on rules() — no per-rule parser() wrappers anywhere.
function grammar() {
  return rules({ trivia: rw }, (r: any) => ({
    C: sequence(literal('c'), literal('d')),
    B: sequence(literal('b'), r.C),
    A: sequence(literal('a'), r.B),
  })) as Record<string, any>
}

const end = (res: any) => (res.ok ? res.span.end : `FAIL@${res.span?.start}`)

describe('rules(factory, { trivia }) — ambient grammar trivia', () => {
  it('run() makes trivia ambient through the whole rule chain (no parser() wraps)', () => {
    const g = grammar()
    expect(run(g.A, 'a b c d').ok).toBe(true)
    expect(run(g.A, 'a b c d').span.end).toBe(7)
    expect(run(g.A, 'abcd').span.end).toBe(4) // trivia optional
  })

  it('incremental parse of a bare mid-grammar rule still gets the trivia', () => {
    const g = grammar()
    expect(run(g.C, 'c d').span.end).toBe(3)     // C alone skips the space
    expect(run(g.B, 'b  c\td').span.end).toBe(6) // B alone, ws run + tab
  })

  it('compiled ≡ interpreter with trivia only on rules()', () => {
    const g = grammar()
    for (const [rule, input] of [[g.A, 'a b c d'], [g.C, 'c  d'], [g.B, 'b c d'], [g.A, 'abcd']] as const) {
      const i = end(rule.parse(input, 0, { trackLines: false, trivia: rw }))
      const c = end(compile(rule).parse(input))
      expect(c, `compiled must match interpreter for ${JSON.stringify(input)}`).toEqual(i)
    }
  })

  it('parse()/run() entry both install the grammar trivia', () => {
    const g = grammar()
    // parse() (grammar.ts) entry
    expect(g.A.parse('a b c d', 0, { trackLines: false } as any) === undefined).toBe(false)
    expect(run(g.A, 'a b c d').ok).toBe(true)
  })

  it('parser({trivia}) / noTrivia still override the grammar default locally', () => {
    // A glued rule using noTrivia inside a grammar whose default is rw.
    const g = rules({ trivia: rw }, (r: any) => ({
      glued: noTrivia(sequence(literal('x'), literal('y'))),
      spaced: sequence(literal('x'), literal('y')),
    })) as Record<string, any>
    // spaced: grammar default rw → "x y" parses
    expect(run(g.spaced, 'x y').ok).toBe(true)
    // glued: noTrivia override → "x y" must FAIL (space not skipped), "xy" ok
    expect(run(g.glued, 'xy').ok).toBe(true)
    expect(run(g.glued, 'x y').ok).toBe(false)
  })

  it('grammars without rules({trivia}) are unaffected (opt-in)', () => {
    const g = rules((r: any) => ({ AB: sequence(literal('a'), literal('b')) })) as Record<string, any>
    // No ambient trivia → "ab" parses, "a b" fails (space breaks the contiguous match).
    expect(run(g.AB, 'ab').span.end).toBe(2)
    expect(run(g.AB, 'a b').ok).toBe(false)
  })
})
