import { describe, it, expect } from 'vitest'
import { rules, sequence, literal, regex, run, parse } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'

const ident = regex(/[a-z]+/)
const num = regex(/[0-9]+/)

// Regression: run()/parse() read `grammarTrivia._meta` whenever grammarTrivia was
// `!== undefined`, but `rules({ trivia: null })` (explicitly clearing ambient
// trivia) makes it null → a crash on `null._meta`. The `!= null` guard treats null
// like undefined ("no ambient trivia") and never stores null as grammarTrivia.
describe('run()/parse() over a trivia-clearing grammar (rules({ trivia: null }))', () => {
  const cleared = rules({ trivia: null }, () => ({ pair: sequence(ident, literal(':'), num) }))

  it('parses contiguously with no ambient trivia, without throwing', () => {
    const r = run(cleared.pair as Combinator<unknown>, 'a:1')
    expect(r.ok).toBe(true)
    expect(r.value).toEqual(['a', ':', '1'])
  })

  it('a space between terms is NOT skipped (trivia is cleared)', () => {
    const r = run(cleared.pair as Combinator<unknown>, 'a : 1')
    expect(r.ok).toBe(false)
  })

  it('the direct parse() entry also handles a null grammarTrivia', () => {
    const r = parse(cleared.pair as Combinator<unknown>, 'a:1')
    expect(r.ok).toBe(true)
  })
})
