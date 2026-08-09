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
  attempt, choice, dispatch, endsWith, field, keywords, literal, makeWhen, matches, otherwise, optional, regex,
  ref, sequence, startsWith, token, transform, when, withCtx,
} from '../../src/index.ts'

function choiceMaskRecords(words: readonly number[]): Array<{
  choice: number
  site: number
  flags: number
  outcomes: number[]
  arms: number[]
}> {
  const records = []
  for (let at = 0; at < words.length;) {
    const size = words[at]!, outcomeCount = words[at + 4]!, armCount = words[at + 5]!
    records.push({
      choice: words[at + 1]!, site: words[at + 2]!, flags: words[at + 3]!,
      outcomes: words.slice(at + 6, at + 6 + outcomeCount),
      arms: words.slice(at + 6 + outcomeCount, at + 6 + outcomeCount + armCount),
    })
    at += size
  }
  return records
}

describe('compact lexical token plan wire', () => {
  it('serializes strict-only compatible outcome masks without widening OP_CHOICE', () => {
    const head = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const named = keywords(['red', 'blue'], { caseInsensitive: true, boundary: '-A-Za-z0-9_(' })
    const classified = dispatch(
      head,
      when(endsWith('('), literal('call')),
      otherwise(literal('ident')),
    )
    // A second classifier contributes an exact compatible view. The Value-like
    // choice does not route it directly, but its endsWith route still accepts
    // that range; the compiler must put both local outcome bits on arm 2.
    const subtype = dispatch(head, makeWhen({ caseInsensitive: true })('each(', literal('each')))
    const root = choice(attempt(literal('@')), named, classified)
    const prog = encodeTable({ Root: root, Subtype: subtype })
    const plan = prog.tokenPlan!
    const [record] = choiceMaskRecords(plan.choiceMasks!)

    expect(record).toBeDefined()
    expect(record!.flags).toBe(1) // strict-only
    expect(record!.arms).toHaveLength(3)
    expect(record!.arms[0]).toBe(0)
    expect(record!.arms[1]).toBeGreaterThan(1)
    expect(record!.arms[2]).toBe((1 << (record!.outcomes.length + 1)) - 2)
    expect(plan.choiceSites).toBeUndefined()
    expect(prog.code[record!.choice]).toBe(OP_CHOICE)
    const armCount = prog.code[record!.choice + 2]!
    expect(armCount).toBe(3)
    // Existing row ABI: header + arms + expected-set operands. No mask operand.
    expect(prog.code[record!.choice + 4 + 2 * armCount]).not.toBe(record!.site)

    const alphabet = collectLexicalAlphabet([root, subtype])
    const family = alphabet.classifiers.find(c => c.dispatch === classified)!.familyId
    const classifiers = alphabet.classifiers.filter(c => c.familyId === family)
    const allowed = (input: string): number[] => {
      let outcomeMask = 0
      for (const classifier of classifiers) {
        for (const id of compatibleLexicalOutcomes(classifier, input, 0, input.length)) {
          const bit = record!.outcomes.indexOf(id)
          if (bit >= 0) outcomeMask |= 1 << (bit + 1)
        }
      }
      const gate = resolveTable(prog).disp[prog.code[record!.choice + 1]!]!
      return record!.arms.flatMap((mask, arm) => {
        const cls = gate.armCls[arm]
        const charAllowed = cls === null || cls === undefined || cls.ascii[input.charCodeAt(0)] === 1
        return charAllowed && (mask === 1 || (mask & outcomeMask) !== 0) ? [arm] : []
      })
    }
    expect(allowed('red')).toEqual([1, 2])
    // The IDENT outcome admits the keyword VIEW, but the current `f` lead does
    // not admit that arm's exact FIRST class. Outcome masks never replace the
    // existing char gate.
    expect(allowed('foo')).toEqual([2])
    expect(allowed('foo(')).toEqual([2])

    const compact: CompactProgram = {
      c: prog.code, k: prog.k, x: prog.cc, e: prog.fx, d: prog.disp,
      r: prog.rules, f: prog.fns, q: plan,
    }
    expect(expandCompact(compact).tokenPlan?.choiceMasks).toEqual(plan.choiceMasks)
    expect(foldPrograms({ base: prog, twin: encodeTable({ Root: root, Subtype: subtype }) }, 'base')
      .base.tokenPlan?.choiceMasks).toEqual(plan.choiceMasks)
    expect(emitTableModule(prog, { fnSources: prog.fns.map(fn => String(fn)) })).toContain('choiceMasks:[')
  })

  it('keeps uncertain/effectful and cyclic arms unrestricted while exact FIRST skips disjoint attempt refs', () => {
    const head = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const classified = dispatch(head, when(endsWith('('), literal('call')), otherwise(literal('ident')))
    const cycle = ref<string>()
    cycle.define(choice(literal('!'), cycle))
    const root = choice(
      attempt(literal('#')),
      withCtx({ active: true }, keywords(['red'], { boundary: '-A-Za-z0-9_(' })),
      cycle,
      keywords(['red'], { boundary: '-A-Za-z0-9_(' }),
      classified,
    )
    const [record] = choiceMaskRecords(encodeTable({ Root: root }).tokenPlan!.choiceMasks!)

    expect(record!.arms[0]).toBe(0)
    expect(record!.arms[1]).toBe(1)
    expect(record!.arms[2]).toBe(1)
    expect(record!.arms[3]).toBeGreaterThan(1)
  })

  it('refuses more than 29 family outcomes and never gives one choice both ownership forms', () => {
    const head = token(regex(/[a-z0-9]+/))
    const exact = Array.from({ length: 30 }, (_, i) => when(`k${i}`, literal(String(i))))
    const classified = dispatch(head, ...exact, otherwise(literal('other')))
    expect(encodeTable({ Root: choice(literal('@'), classified) }).tokenPlan).toBeUndefined()

    const bounded = dispatch(head, when('one', literal('one')), otherwise(literal('other')))
    const transformed = choice(transform(bounded, value => value), head)
    const plan = encodeTable({ Root: transformed }).tokenPlan!
    expect(plan.choiceSites).toHaveLength(3)
    expect(plan.choiceMasks).toBeUndefined()
  })

  it('declines unsupported outcome predicates and keeps CI keyword/CS outcome ambiguity unrestricted', () => {
    const head = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const named = keywords(['red'], { caseInsensitive: true, boundary: '-A-Za-z0-9_(' })
    const unsupported = dispatch(head, when(matches(/^foo.*bar$/), literal('x')), otherwise(literal('y')))
    expect(encodeTable({ Root: choice(attempt(literal('@')), named, unsupported) }).tokenPlan).toBeUndefined()

    const unstable = dispatch(head, when('red', literal('red')), otherwise(literal('other')))
    expect(encodeTable({
      Root: choice(attempt(literal('@')), named, unstable),
    }).tokenPlan).toBeUndefined()
  })

  it('relocates each mask through its exact encoded dispatch site', () => {
    const head = token(sequence(regex(/[A-Za-z-]+/), optional(literal('('))))
    const named = keywords(['red'], { boundary: '-A-Za-z0-9_(' })
    const one = dispatch(head, when(endsWith('('), literal('one')), otherwise(literal('ident')))
    const two = dispatch(head, when(endsWith('('), literal('two')), otherwise(literal('ident')))
    const a = choice(attempt(literal('@')), named, one)
    const b = choice(attempt(literal('#')), named, two)
    const prog = encodeTable({ A: a, B: b })
    const records = choiceMaskRecords(prog.tokenPlan!.choiceMasks!)
    expect(records).toHaveLength(2)
    for (const record of records) {
      const dispatchIp = prog.code[record.choice + 4 + 2]!
      expect(prog.code[dispatchIp]).toBe(OP_DISPATCH)
      expect(prog.code[dispatchIp + 2]).toBe(prog.tokenPlan!.sites[4 * record.site])
    }
  })
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
    const plannerOnly = '__planner_only_prefix__'
    const direct = dispatch(head, when(startsWith(plannerOnly), literal('x')), otherwise(literal('y')))
    const nested = transform(sequence(literal(':'), direct), value => value)
    const prog = encodeTable({ Root: choice(direct, nested) })

    expect(prog.tokenPlan).toBeUndefined()
    expect(prog.k).not.toContain(plannerOnly)
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
