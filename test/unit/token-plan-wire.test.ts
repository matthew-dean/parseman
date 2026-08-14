import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { emitTableOnly } from '../../src/table/emit.ts'
import { expandCompact, foldPrograms, type CompactProgram } from '../../src/table/program.ts'
import {
  collectLexicalAlphabet, canonicalLexicalOutcomeKey, compatibleLexicalOutcomes, selectedLexicalOutcome,
} from '../../src/compiler/token-alphabet.ts'
import {
  dispatch, endsWith, field, literal, makeWhen, otherwise, optional, regex,
  sequence, startsWith, token, when,
} from '../../src/index.ts'

describe('compact lexical token plan wire', () => {
  it('fails closed instead of serializing a partial token plan', () => {
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
    const unsupported = token(sequence(regex(/[0-9]+/), literal(')')))

    const root = sequence(first, duplicate, unsupported)
    const prog = encodeTable({ Root: root })
    const alphabet = collectLexicalAlphabet([root])
    expect(alphabet.capabilityComplete).toBe(false)
    expect(alphabet.capabilities.filter(site => site.atom !== 'terminal').map(site => site.atom))
      .toEqual(['dispatch', 'token', 'dispatch', 'token'])
    expect('tokenPlan' in prog).toBe(false)
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
    expect('tokenPlan' in prog).toBe(false)
    expect(collectLexicalAlphabet([refused])).toMatchObject({
      recognizers: [], outcomes: [], classifiers: [],
      sites: [{ refusal: 'field is effectful' }],
    })
  })

  it('keeps compact, folded, and macro artifacts free of a partial plan', () => {
    const head = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const root = dispatch(head, when(startsWith('x'), literal('x')), otherwise(literal('y')))
    const prog = encodeTable({ Root: root })
    expect('tokenPlan' in prog).toBe(false)
    const compact: CompactProgram = {
      c: prog.code, k: prog.k, x: prog.cc, e: prog.fx, d: prog.disp,
      r: prog.rules, f: prog.fns,
    }
    expect('tokenPlan' in expandCompact(compact)).toBe(false)
    expect('tokenPlan' in foldPrograms({ base: prog, twin: encodeTable({ Root: root }) }, 'base').base)
      .toBe(false)
    const macroPath = compileRuleMap([['Root', root]])
    expect(macroPath == null ? true : !('tokenPlan' in macroPath.prog)).toBe(true)
    expect(macroPath?.replacement).not.toContain('q:{recognizerOffsets:[')
    expect(emitTableOnly(prog)).not.toMatch(/tokenPlan|_tok|recognizerOffsets/)
  })
})
