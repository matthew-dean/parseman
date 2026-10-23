/**
 * A disjoint choice whose first-character dispatch finds no arm fails without
 * running any arm, and reports the arms' derived expectations: the set its
 * scalar path, `run()` and `compile()` report for the same miss.
 */
import { describe, expect, it } from 'vitest'
import { choice, compile, completionsAt, keywords, literal, optional, parse, regex, run, sequence, withCtx, word } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'

const ctx = () => ({ trackLines: false })
const grammars: Record<string, Combinator<unknown>> = {
  regexes: choice(regex(/`{3,}/), regex(/~{3,}/)),
  // A nullable prefix: the arm could fail at either term.
  nullablePrefix: choice(sequence(optional(literal('x')), literal('b')), literal('c')),
  // A keyword arm's derived set recites its literals.
  keywords: choice(word('if'), keywords(['for', 'while'])),
}

describe('a disjoint choice dispatch miss', () => {
  for (const [name, grammar] of Object.entries(grammars)) {
    it(`${name}: the interpreter reports what run() and compile() report`, () => {
      expect(grammar._def).toMatchObject({ tag: 'choice', disjoint: true })
      const compiled = compile(grammar)
      for (const input of ['hello', '']) {
        const interpreted = grammar.parse(input, 0, ctx())
        const table = compiled.parseWithContext(input, ctx(), 0)
        if (interpreted.ok || table.ok) throw new Error(`${name} matched ${JSON.stringify(input)}`)
        expect(interpreted.expected).toEqual(run(grammar, input).expected)
        expect(interpreted.expected).toEqual(table.expected)
        expect(parse(grammar, input).ok).toBe(false)
      }
    })
  }

  it('runs no arm', () => {
    let entered = 0
    const arm = (text: string) => withCtx(state => { entered++; return state }, literal(text))
    const grammar = choice(arm('a'), arm('b'))
    const missed = grammar.parse('z', 0, ctx())
    expect(missed).toEqual({ ok: false, expected: ['"a"', '"b"'], span: { start: 0, end: 0 } })
    expect(entered).toBe(0)
    expect(grammar.parse('b', 0, ctx()).ok).toBe(true)
    expect(entered).toBe(1)
  })

  it('still lets a completion probe see each arm fail', () => {
    const grammar = sequence(literal('{'), choice(regex(/red|blue/), regex(/[0-9]+/)))
    expect(completionsAt(grammar, '{', 1)).toEqual(['/red|blue/', '/[0-9]+/'])
  })

  it('returns a fresh expected array each time', () => {
    const grammar = grammars.regexes!
    const first = grammar.parse('z', 0, ctx())
    if (first.ok) throw new Error('expected a miss')
    first.expected.push('mutated')
    const second = grammar.parse('z', 0, ctx())
    expect(second.ok ? [] : second.expected).toEqual(['/`{3,}/', '/~{3,}/'])
  })
})
