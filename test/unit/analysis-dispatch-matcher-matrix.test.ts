import { describe, expect, it } from 'vitest'
import {
  analyzeChoiceInventory,
  analyzeGating,
  choice,
  dispatch,
  literal,
  matches,
  otherwise,
  parser,
  regex,
  routed,
  rules,
  sequence,
  trivia,
  when,
  type Combinator,
} from '../../src/index.ts'
import { childrenOf, ruleDependencies } from '../../src/analysis/gating.ts'

describe('analysis traversal through dispatch matcher arms', () => {
  it('exposes selector, exact, matcher, and otherwise children in authored order', () => {
    const selector = regex(/[a-z]+/)
    const exact = literal('!')
    const matcher = literal('?')
    const fallback = literal('.')
    const parser = dispatch(
      selector,
      when('word', exact),
      when(matches(/^pre/), matcher),
      otherwise(fallback),
    )

    expect(childrenOf(parser._def)).toEqual([selector, exact, matcher, fallback])
  })

  it('includes choices nested only inside matcher arms in the static inventory', () => {
    const nested = choice(
      sequence(literal('x'), literal('1')),
      sequence(literal('x'), literal('2')),
    )
    const root = dispatch(
      regex(/[a-z]+/),
      when(matches(/^x/), nested),
      otherwise(literal('!')),
    )

    const report = analyzeChoiceInventory([['Root', root as Combinator<unknown>]])
    expect(report.choiceSites).toBe(1)
    expect(report.entries[0]).toMatchObject({
      site: { rule: 'Root', path: 'dispatch[0]' },
    })
  })

  it('includes rule dependencies referenced only by matcher arms', () => {
    const grammar = rules(self => ({
      Root: dispatch(
        regex(/[a-z]+/),
        when('exact', self.Exact),
        when(matches(/^pre/), self.Matcher),
        otherwise(self.Fallback),
      ),
      Exact: literal('!'),
      Matcher: literal('?'),
      Fallback: literal('.'),
    }))
    const entries = Object.entries(grammar) as Array<[string, Combinator<unknown>]>

    expect(ruleDependencies(entries).get('Root')).toEqual(['Exact', 'Matcher', 'Fallback'])
    expect(ruleDependencies(entries).get('Matcher')).toEqual([])
  })
})

describe('analysis traversal through scoped and routed fallbacks', () => {
  it('analyzes choices under routed fallbacks and grammar trivia scopes', () => {
    const routedChoice = choice(regex(/.*/), literal('x'))
    expect(childrenOf(routed(routedChoice)._def)).toEqual([routedChoice])
    expect(analyzeGating(routed(routedChoice)).totalChoices).toBe(1)
    expect(analyzeChoiceInventory([['Root', routed(routedChoice)]]).choiceSites).toBe(1)

    const triviaChoice = trivia(choice(regex(/.*/), regex(/\s+/)))
    const scoped = parser({ trivia: triviaChoice }, literal('x'))
    expect(analyzeGating(scoped).totalChoices).toBe(1)
    expect(analyzeChoiceInventory([['Root', scoped]]).choiceSites).toBe(1)
  })

  it('includes dependencies referenced only by routed fallbacks', () => {
    const grammar = rules(self => ({
      Root: routed(self.Fallback),
      Fallback: literal('x'),
    }))
    const entries = Object.entries(grammar) as Array<[string, Combinator<unknown>]>
    expect(ruleDependencies(entries).get('Root')).toEqual(['Fallback'])
  })
})
