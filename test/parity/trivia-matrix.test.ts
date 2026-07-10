import { describe, it, expect } from 'vitest'
import {
  rules, compose, parser, noTrivia, trivia, sequence, literal, oneOrMore, choice, regex, run, parse, compile,
} from '../../src/index.ts'

// Two trivia flavors with an OBSERVABLE difference:
//  - ws  : whitespace only
//  - wsc : whitespace OR a /*…*/ block comment
const ws  = trivia(oneOrMore(regex(/[ \t\n]+/)))
const wsc = trivia(oneOrMore(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//))))

// End position on success, or a FAIL marker — for a plain (non-compose) grammar,
// asserted equal across interpreter (.parse) and compiled (compile().parse).
const endI = (r: any) => (r.ok ? r.span.end : 'FAIL')
function both(entry: any, input: string): { i: string | number; c: string | number } {
  // `parse()` (grammar.ts) installs the grammar's ambient trivia; compile() bakes it.
  return { i: endI(parse(entry, input)), c: endI(compile(entry).parse(input)) }
}
// For a composed grammar: runtime fuse (new Function) — its rules ARE compiled.
const endR = (r: any) => (r.ok ? r.span.end : 'FAIL')

describe('trivia matrix — settings applied throughout (interpreter ≡ compiler)', () => {
  it('grammar trivia reaches a deeply nested rule chain', () => {
    const g = rules({ trivia: ws }, (r: any) => ({
      A: sequence(literal('a'), r.B),
      B: sequence(literal('b'), r.C),
      C: sequence(literal('c'), literal('d')),
    })) as Record<string, any>
    const { i, c } = both(g.A, 'a b c d')
    expect(i).toBe(7)
    expect(c).toBe(i)
  })

  it('noTrivia override inside a grammar: the region is glued, the surroundings still skip', () => {
    const g = rules({ trivia: ws }, (r: any) => ({
      Doc: sequence(literal('x'), r.Inner, literal('y')),
      Inner: noTrivia(sequence(literal('p'), literal('q'))),
    })) as Record<string, any>
    // spaces around Inner are skipped; Inner itself must be glued
    expect(both(g.Doc, 'x pq y')).toEqual({ i: 6, c: 6 })
    // a space INSIDE Inner must fail — and revert: after Inner, trivia resumes
    expect(both(g.Doc, 'x p q y')).toEqual({ i: 'FAIL', c: 'FAIL' })
  })

  it('parser({trivia: other}) override inside a grammar: the region uses the OTHER trivia', () => {
    // Base grammar skips whitespace only; Inner additionally skips comments.
    const g = rules({ trivia: ws }, (r: any) => ({
      Doc: sequence(literal('x'), r.Inner),
      Inner: parser({ trivia: wsc }, sequence(literal('p'), literal('q'))),
    })) as Record<string, any>
    // comment BETWEEN p and q is skipped by Inner's wsc
    expect(both(g.Doc, 'x p/*c*/q')).toEqual({ i: 9, c: 9 })
    // but a comment OUTSIDE Inner (between x and Inner) is NOT skipped by the base ws → fail
    expect(both(g.Doc, 'x/*c*/pq')).toEqual({ i: 'FAIL', c: 'FAIL' })
  })

  it('compose: the composing grammar’s trivia reaches an INHERITED base rule (outermost-wins)', () => {
    // base skips ws; the composing delta skips ws+comments and references base.Pair.
    const base = rules({ trivia: ws }, (_g: any) => ({ Pair: sequence(literal('a'), literal('b')) }))
    const g = compose([
      base,
      rules({ trivia: wsc }, (g: any) => ({ Doc: sequence(literal('x'), g.Pair) })),
    ]) as Record<string, any>
    // A comment sits between 'a' and 'b' — those terms live in the INHERITED base Pair rule.
    // Under outermost-wins the composed grammar's wsc applies there too, so it's skipped.
    expect(endR(run(g.Doc, 'x a/*c*/b'))).toBe(9)
    // plain whitespace obviously works
    expect(endR(run(g.Doc, 'x a b'))).toBe(5)
  })

  it('compose (2-level): the deepest inherited rule adopts the OUTERMOST grammar’s trivia', () => {
    // css → less → scss. The deepest rule (css.Pair) is inherited through TWO compose
    // levels. Under composing-wins, the OUTERMOST grammar's trivia (scss's wsc) must
    // govern it — which only works if the intermediate `less` composed result is stored
    // RE-LOWERABLE (IR), so re-composing scss re-lowers css.Pair under wsc.
    const css = rules({ trivia: ws }, (_g: any) => ({ Pair: sequence(literal('a'), literal('b')) }))
    const less = compose([css, rules({ trivia: ws }, (g: any) => ({ Mid: sequence(literal('m'), g.Pair) }))]) as Record<string, any>
    const scss = compose([less, rules({ trivia: wsc }, (g: any) => ({ Doc: sequence(literal('x'), g.Mid) }))]) as Record<string, any>
    // 'a'/'b' live in the DEEPEST css.Pair rule; a comment between them is skipped only
    // if scss's wsc reached that far.
    expect(endR(run(scss.Doc, 'x m a/*c*/b'))).toBe(11)
    expect(endR(run(scss.Doc, 'x m a b'))).toBe(7)
    // …and the intermediate `less` composed ALONE still uses its own ws — a comment
    // inside its inherited Pair is NOT skipped (each level's composing trivia is local).
    expect(endR(run(less.Mid, 'm a/*c*/b'))).toBe('FAIL')
    expect(endR(run(less.Mid, 'm a b'))).toBe(5)
  })

  it('compose: a delta that declares no trivia of its own inherits the base grammar’s', () => {
    // Only `base` declares trivia (ws + comments); the delta declares none. The composed
    // grammar still skips the base's trivia everywhere — the trivia rides with the grammar
    // that declared it, no re-declaration at compose().
    const base = rules({ trivia: wsc }, (_g: any) => ({ Pair: sequence(literal('a'), literal('b')) }))
    const g = compose([base, rules((g: any) => ({ Doc: sequence(literal('x'), g.Pair) }))]) as Record<string, any>
    expect(endR(run(g.Doc, 'x a/*c*/b'))).toBe(9)   // base's wsc governs the delta's Doc too
    expect(endR(run(g.Doc, 'xab'))).toBe(3)
  })
})
