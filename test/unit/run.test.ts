/**
 * `run()` — the generic "invoke a grammar entry and collect the raw outcome"
 * driver, so a consumer doesn't hand-build ctx, branch fn-vs-combinator, or scan
 * for leftover input. Works on BOTH the interpreter (combinators) and the
 * compiled map (bare functions), and reports leftover after skipping the
 * grammar's own trivia.
 */
import { describe, it, expect } from 'vitest'
import { rules, regex, many, choice, parser, trivia, node, compile, run } from '../../src/index.ts'

const blockTrivia = trivia(many(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//))))
const lineTrivia = trivia(many(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//), regex(/\/\/[^\n]*/))))

describe('run() — generic grammar-entry driver', () => {
  const g = rules(gg => ({ Doc: parser({ trivia: blockTrivia }, many(gg.W)), W: node('W', regex(/[a-z]+/)) }))

  it('invokes an interpreter combinator and reports full consumption', () => {
    const r = run(g.Doc as never, 'a b c')
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null)
  })

  it('invokes a compiled function entry the same way', () => {
    const c = compile(g.Doc)
    const r = run(c.parse as never, 'a b c')
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null)
  })

  it('reports leftover at the first non-trivia offset', () => {
    // `!` is not a word and not trivia → leftover after "a b ".
    const r = run(g.Doc as never, 'a b !', { trivia: blockTrivia as never })
    expect(r.unconsumedFrom).toBe(4)
  })

  it('trailing trivia is NOT leftover (dialect encoded by which trivia is passed)', () => {
    const src = 'a b // tail\n'
    // CSS-style trivia: `//` is not trivia → leftover at the `//`.
    expect(run(g.Doc as never, src, { trivia: blockTrivia as never }).unconsumedFrom).toBe(4)
    // Less-style trivia: `//` line comment IS trivia → fully consumed.
    expect(run(g.Doc as never, src, { trivia: lineTrivia as never }).unconsumedFrom).toBe(null)
  })

  it('surfaces an unterminated comment as leftover at its start', () => {
    const r = run(g.Doc as never, 'a /* oops', { trivia: blockTrivia as never })
    expect(r.unconsumedFrom).toBe(2)   // the unterminated comment never matches trivia
  })

  it('threads the ctx.build host to structural node() rules', () => {
    const built: string[] = []
    const r = run(g.Doc as never, 'a', { build: (type: string) => { built.push(type); return { type } } })
    expect(r.ok).toBe(true)
    expect(built).toContain('W')
  })

  it('throws a clear TypeError when the start production is not a rule', () => {
    // e.g. a missing grammar rule: `grammar[name]` came back undefined.
    expect(() => run(undefined as never, 'a b c')).toThrow(TypeError)
    expect(() => run(undefined as never, 'a b c')).toThrow(/not a rule|does not exist/)
    // A valid entry still parses — no regression.
    expect(run(g.Doc as never, 'a b c').ok).toBe(true)
  })
})
