import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { expandCompact, foldPrograms, type CompactProgram } from '../../src/table/program.ts'
import {
  collectLexicalAlphabet, canonicalLexicalOutcomeKey, compatibleLexicalOutcomes, selectedLexicalOutcome,
} from '../../src/compiler/token-alphabet.ts'
import {
  dispatch, endsWith, field, literal, makeWhen, otherwise, optional, regex,
  sequence, startsWith, token, when,
} from '../../src/index.ts'

describe('compact lexical token plan wire', () => {
  it('serializes atomic family-qualified outcomes and keeps grouping on ordered routes', () => {
    const head = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const ci = makeWhen({ caseInsensitive: true })
    const first = dispatch(
      head,
      ci(['URL(', 'var(', 'calc('], literal('known')),
      when(endsWith('('), literal('open')),
      otherwise(literal('ident')),
    )
    const duplicate = dispatch(
      head,
      when(endsWith('('), literal('one')),
      when(endsWith('('), literal('two')),
      otherwise(literal('other')),
    )

    const prog = encodeTable({ Root: sequence(first, duplicate) })
    const plan = prog.tokenPlan!
    expect(plan).toBeDefined()
    expect(Object.values(plan).every(value => Array.isArray(value)
      && value.every(word => Number.isInteger(word)))).toBe(true)

    // Recognizer ids are implicit array indices; family ids occupy their own
    // namespace. Exact values are three atomic outcomes, grouped only by the
    // first site route's accepted-id slice.
    expect(plan.recognizerOffsets).toHaveLength(1)
    expect(plan.tokenSites).toHaveLength(2)
    expect(plan.sites).toHaveLength(8)
    const firstRoute = plan.routes.slice(plan.sites[2]!, plan.sites[2]! + 4)
    expect(firstRoute[3]).toBe(3)
    expect(new Set(plan.accepted.slice(firstRoute[2]!, firstRoute[2]! + firstRoute[3]!)).size).toBe(3)

    // Duplicate predicates remain two ordered route identities but reuse one
    // atomic global outcome id.
    const secondRouteOffset = plan.sites[6]!
    const route0 = plan.routes.slice(secondRouteOffset, secondRouteOffset + 4)
    const route1 = plan.routes.slice(secondRouteOffset + 4, secondRouteOffset + 8)
    expect(route0[0]).toBe(0)
    expect(route1[0]).toBe(1)
    expect(plan.accepted[route0[2]!]).toBe(plan.accepted[route1[2]!])
  })

  it('assigns canonical ids independent of root order and keeps CI distinct from CS', () => {
    const a = token(regex(/[a-z]+/))
    const b = token(regex(/[0-9]+/))
    const ci = dispatch(a, makeWhen({ caseInsensitive: true })('URL', literal('ci')), otherwise(literal('x')))
    const cs = dispatch(a, when('URL', literal('cs')), otherwise(literal('y')))
    const one = collectLexicalAlphabet([ci, cs, b])
    const two = collectLexicalAlphabet([b, cs, ci])

    expect(one.recognizers.map(r => [r.id, r.key])).toEqual(two.recognizers.map(r => [r.id, r.key]))
    expect(one.outcomes.map(o => [o.id, o.familyId, canonicalLexicalOutcomeKey(o.match)]))
      .toEqual(two.outcomes.map(o => [o.id, o.familyId, canonicalLexicalOutcomeKey(o.match)]))
    expect(one.classifiers[0]!.outcomes[0]!.id).not.toBe(one.classifiers[1]!.outcomes[0]!.id)
  })

  it('keeps exact each/url routes ahead of compatible generic function views', () => {
    const head = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const ci = makeWhen({ caseInsensitive: true })
    const parser = dispatch(
      head,
      ci(['each(', 'url(', 'calc('], literal('special')),
      when(endsWith('('), literal('generic')),
      otherwise(literal('ident')),
    )
    const classifier = collectLexicalAlphabet([parser]).classifiers[0]!
    for (const input of ['each(', 'URL(', 'calc(']) {
      const compatible = compatibleLexicalOutcomes(classifier, input, 0, input.length)
      expect(compatible).toHaveLength(2)
      expect(selectedLexicalOutcome(classifier, input, 0, input.length)).toMatchObject({
        route: { index: 0 }, outcomeId: compatible[0],
      })
    }
    expect(selectedLexicalOutcome(classifier, 'plain', 0, 5)).toMatchObject({ route: { kind: 'otherwise' } })
  })

  it('refuses effectful token spellings without allocating wire metadata', () => {
    const refused = token(field('name', regex(/[a-z]+/)))
    const prog = encodeTable({ Root: refused })
    expect(prog.tokenPlan).toBeUndefined()
    expect(collectLexicalAlphabet([refused])).toMatchObject({
      recognizers: [], outcomes: [], classifiers: [],
      sites: [{ refusal: 'field is effectful' }],
    })
  })

  it('round-trips compact and folded programs without changing the numeric plan', () => {
    const head = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const root = dispatch(head, when(startsWith('x'), literal('x')), otherwise(literal('y')))
    const prog = encodeTable({ Root: root })
    const compact: CompactProgram = {
      c: prog.code, k: prog.k, x: prog.cc, e: prog.fx, d: prog.disp,
      r: prog.rules, f: prog.fns, q: prog.tokenPlan!,
    }
    expect(expandCompact(compact).tokenPlan).toEqual(prog.tokenPlan)
    expect(foldPrograms({ base: prog, twin: encodeTable({ Root: root }) }, 'base').base.tokenPlan)
      .toEqual(prog.tokenPlan)
    const macroPath = compileRuleMap([['Root', root]])
    expect(macroPath?.prog.tokenPlan).toEqual(prog.tokenPlan)
    expect(macroPath?.replacement).toContain('q:{recognizerOffsets:[')
  })
})
