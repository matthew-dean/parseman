import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { expandCompact, foldPrograms, resolveTable, type CompactProgram } from '../../src/table/program.ts'
import { execRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { OP_CHOICE, OP_DISPATCH, OP_XFORM } from '../../src/table/ops.ts'
import { runtimeRangeOutcomeKind } from '../../src/table/token-outcome.ts'
import {
  collectLexicalAlphabet, canonicalLexicalOutcomeKey, compatibleLexicalOutcomes, selectedLexicalOutcome,
} from '../../src/compiler/token-alphabet.ts'
import {
  choice, dispatch, endsWith, field, literal, makeWhen, matches, otherwise, optional, regex,
  ref, sequence, startsWith, token, transform, when,
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

    const prog = encodeTable({
      First: choice(transform(first, value => value), head),
      Duplicate: choice(transform(duplicate, value => value), head),
    })
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

  it('keeps a selector reached through an effect-bearing wrapper on legacy dispatch', () => {
    const head = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const selector = ref<string>()
    selector.define(head)
    const parser = dispatch(selector, when(endsWith('('), literal('call')), otherwise(literal('ident')))
    const prog = encodeTable({ Root: parser })

    // Choice-anchored activation refuses the effect-bearing selector entirely.
    expect(prog.tokenPlan).toBeUndefined()
    const table = execRules(prog).Root!
    for (const input of ['fooident', 'foo(call', 'foo?']) {
      expect(run(table, input)).toEqual(run(parser, input))
    }
  })

  it('omits an unsupported choice anchor entirely', () => {
    const head = token(sequence(regex(/[a-z]+/), literal(':')))
    const parser = dispatch(
      head,
      when(matches(/^[a-z]+:$/), literal('matched')),
      otherwise(literal('other')),
    )
    const prog = encodeTable({ Root: choice(transform(parser, value => value), head) })

    expect(prog.tokenPlan).toBeUndefined()
    const source = run(parser, 'abc:matched')
    expect(source.ok).toBe(true)
    expect(run(execRules(prog).Root!, 'abc:matched')).toEqual(source)
  })

  it('keeps all bounded runtime range predicate forms', () => {
    const head = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const parsers = [
      dispatch(head, when('url(', literal('x')), otherwise(literal('o'))),
      dispatch(head, when(startsWith('x'), literal('x')), otherwise(literal('o'))),
      dispatch(head, when(endsWith('('), literal('x')), otherwise(literal('o'))),
      dispatch(head, when(matches(/^foo/i), literal('x')), otherwise(literal('o'))),
      dispatch(head, when(matches(/^(?!(?:url|calc)\($).+\($/i), literal('x')), otherwise(literal('o'))),
    ]
    const plan = encodeTable(Object.fromEntries(parsers.map((parser, i) => [
      `Root${i}`, choice(transform(parser, value => value), head),
    ]))).tokenPlan!

    expect(plan.sites).toHaveLength(parsers.length * 4)
    expect(String(runtimeRangeOutcomeKind)).not.toContain('RegExp')
    expect(String(runtimeRangeOutcomeKind)).not.toContain('.test(')
  })

  it('serializes only direct same-position XFORM to planned DISPATCH choice arms', () => {
    const head = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const classified = dispatch(head, when('each(', literal('each')), when(endsWith('('), literal('call')))
    const functionStatement = transform(classified, value => value)
    const direct = dispatch(head, otherwise(literal('direct')))
    const nested = transform(sequence(literal(':'), classified), value => value)
    const root = choice(literal('@'), functionStatement, direct, nested)
    const prog = encodeTable({ Root: root })
    const plan = prog.tokenPlan!

    expect(plan.choiceSites).toHaveLength(3)
    const choiceIp = plan.choiceSites![0]!, armIndex = plan.choiceSites![1]!, siteIndex = plan.choiceSites![2]!
    expect(prog.code[choiceIp]).toBe(OP_CHOICE)
    expect(armIndex).toBe(1)
    const xf = prog.code[choiceIp + 4 + armIndex]!
    expect(prog.code[xf]).toBe(OP_XFORM)
    const dispatchIp = prog.code[xf + 2]!
    expect(prog.code[dispatchIp]).toBe(OP_DISPATCH)
    expect(prog.code[dispatchIp + 2]).toBe(plan.sites[4 * siteIndex])
    const choiceDispatch = resolveTable(prog).disp[prog.code[choiceIp + 1]!]!
    expect(choiceDispatch.armCls[armIndex]?.ascii['@'.charCodeAt(0)]).toBe(0)

    const compact: CompactProgram = {
      c: prog.code, k: prog.k, x: prog.cc, e: prog.fx, d: prog.disp,
      r: prog.rules, f: prog.fns, q: plan,
    }
    expect(expandCompact(compact).tokenPlan?.choiceSites).toEqual(plan.choiceSites)
    expect(foldPrograms({ base: prog, twin: encodeTable({ Root: root }) }, 'base').base.tokenPlan?.choiceSites)
      .toEqual(plan.choiceSites)
    expect(emitTableModule(prog, { fnSources: prog.fns.map(fn => String(fn)) })).toContain('choiceSites:[')
  })

  it('omits the whole token plan when no outer arm has the proven shape', () => {
    const head = token(regex(/[a-z]+/))
    const direct = dispatch(head, otherwise(literal('x')))
    const nested = transform(sequence(literal(':'), direct), value => value)
    const prog = encodeTable({ Root: choice(direct, nested) })

    expect(prog.tokenPlan).toBeUndefined()
    const module = emitTableModule(prog, { fnSources: prog.fns.map(fn => String(fn)) })
    expect(module).not.toContain('choiceSites:')
    expect(module).not.toContain('q:{')
  })

  it('refuses an ambiguous choice with two qualifying transformed dispatch arms', () => {
    const head = token(regex(/[a-z]+/))
    const one = transform(dispatch(head, when('one', literal('1'))), value => value)
    const two = transform(dispatch(head, when('two', literal('2'))), value => value)
    const prog = encodeTable({ Root: choice(one, two) })

    expect(prog.tokenPlan).toBeUndefined()
  })

  it('refuses a qualifying arm when the outer choice is already exclusive', () => {
    const head = token(regex(/[a-z]+/))
    const classified = transform(dispatch(head, when('one', literal('1'))), value => value)
    const prog = encodeTable({ Root: choice(classified, literal('@')) })

    expect(resolveTable(prog).disp.some(d => d.exclusive)).toBe(true)
    expect(prog.tokenPlan).toBeUndefined()
  })

  it('keeps equal route shapes on different token families at distinct dsp sites', () => {
    const words = token(regex(/[a-z]+/))
    const numbers = token(regex(/[0-9]+/))
    const wordDispatch = dispatch(words, when('same', literal('w')), otherwise(literal('x')))
    const numberDispatch = dispatch(numbers, when('same', literal('n')), otherwise(literal('x')))
    const plan = encodeTable({
      Words: choice(transform(wordDispatch, value => value), words),
      Numbers: choice(transform(numberDispatch, value => value), numbers),
    }).tokenPlan!

    expect(plan.sites).toHaveLength(8)
    expect(plan.sites[0]).not.toBe(plan.sites[4])
    expect(plan.sites[1]).not.toBe(plan.sites[5])
  })

  it('keeps family/outcome namespaces stable with an earlier independent token and root relocation', () => {
    const simple = token(literal('!'))
    const head = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const routed = dispatch(head, when(endsWith('('), literal('call')), otherwise(literal('ident')))
    const routedChoice = choice(transform(routed, value => value), head)
    const a = encodeTable({ Simple: simple, Routed: routedChoice }).tokenPlan!
    const b = encodeTable({ Routed: routedChoice, Simple: simple }).tokenPlan!

    expect(a.recognizerOffsets).toHaveLength(2)
    const activeRecognizer = a.sites[1]! - 3
    expect(a.recognizerOffsets[activeRecognizer]).toBeGreaterThanOrEqual(0)
    expect(a.recognizerOffsets.filter(offset => offset < 0)).toHaveLength(1)
    expect(a.recognizerData.length).toBeLessThan(20)
    expect(a.sites[1]).toBeGreaterThanOrEqual(3)
    expect(a.outcomeOffsets.map(offset => a.outcomeData[offset])).toEqual(
      b.outcomeOffsets.map(offset => b.outcomeData[offset]),
    )
    expect(a.sites[1]).toBe(b.sites[1])
    // Site relocation is by the encoded dsp operand, never by authored/root
    // order or a hard-coded instruction pointer.
    for (const [prog, plan] of [
      [encodeTable({ Simple: simple, Routed: routedChoice }), a],
      [encodeTable({ Routed: routedChoice, Simple: simple }), b],
    ] as const) {
      const dsp = plan.sites[0]!
      expect(prog.code.some((word, ip) => word === OP_DISPATCH && prog.code[ip + 2] === dsp)).toBe(true)
    }
  })

  it('round-trips compact and folded programs without changing the numeric plan', () => {
    const head = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const classified = dispatch(head, when(startsWith('x'), literal('x')), otherwise(literal('y')))
    const root = choice(transform(classified, value => value), head)
    const prog = encodeTable({ Root: root })
    const compact: CompactProgram = {
      c: prog.code, k: prog.k, x: prog.cc, e: prog.fx, d: prog.disp,
      r: prog.rules, f: prog.fns, q: prog.tokenPlan!,
    }
    expect(expandCompact(compact).tokenPlan).toEqual(prog.tokenPlan)
    expect(foldPrograms({ base: prog, twin: encodeTable({ Root: root }) }, 'base').base.tokenPlan)
      .toEqual(prog.tokenPlan)
    const macroPath = compileRuleMap([['Root', root]], { fnSources: ['value => value'] })
    expect(macroPath?.prog.tokenPlan).toEqual(prog.tokenPlan)
    expect(macroPath?.replacement).toContain('q:{recognizerOffsets:[')
  })
})
