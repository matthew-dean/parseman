import { describe, expect, it } from 'vitest'
import {
  assertLexicalCapabilityClosure,
  collectLexicalCapabilities,
  type LexicalCapabilityInventory,
  type LexicalDecisionEffectProgram,
  type LexicalFinalDecisionAuthority,
} from '../../src/compiler/token-alphabet.ts'
import {
  choice, dispatch, literal, regex, routed, rules, run, sequence, token, transform, when,
  type Combinator, type ParseContext,
} from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableRules } from '../../src/table/assemble.ts'

function c2(
  roots: readonly Combinator<unknown>[],
  resolve?: (name: string) => Combinator<unknown> | undefined,
): LexicalCapabilityInventory {
  return collectLexicalCapabilities(roots, resolve)
}

function authorityFor(inventory: LexicalCapabilityInventory, siteId = 0): LexicalFinalDecisionAuthority {
  expect(inventory.decisionEffectPlan.finalDecisionAuthorities,
    'C2 RED: final winner-resolved decision authority is not implemented').toBeDefined()
  const authority = inventory.decisionEffectPlan.finalDecisionAuthorities
    .find(entry => entry.decisionSiteId === siteId)
  expect(authority, `missing final decision authority ${siteId}`).toBeDefined()
  return authority!
}

function effectFor(inventory: LexicalCapabilityInventory, siteId = 0): LexicalDecisionEffectProgram {
  expect(inventory.decisionEffectPlan.decisionEffects,
    'C2 RED: compiler-only decision effect programs are not implemented').toBeDefined()
  const effect = inventory.decisionEffectPlan.decisionEffects
    .find(entry => entry.decisionSiteId === siteId)
  expect(effect, `missing decision effect ${siteId}`).toBeDefined()
  return effect!
}

describe('token Stage C2 compiler-only decision effects', () => {
  it('projects final winner exclusivity while pinning the broader construction-time oracle', () => {
    const grammar = rules((g: Record<string, Combinator<unknown>>) => ({
      Entry: choice(g.A!, g.B!),
      A: sequence(literal('a'), literal('x')),
      B: sequence(literal('b'), literal('y')),
    })) as unknown as Record<string, Combinator<unknown>>
    const inventory = c2([grammar.Entry!], name => grammar[name])

    expect(grammar.Entry!._def.tag).toBe('choice')
    if (grammar.Entry!._def.tag !== 'choice') return
    expect(grammar.Entry!._def.disjoint).toBe(false) // construction metadata is stale

    const authority = authorityFor(inventory)
    expect(authority).toMatchObject({ atom: 'choice', mode: { kind: 'exclusive' } })
    const effect = effectFor(inventory)
    expect(effect.finalDecisionAuthorityId).toBe(authority.id)
    expect(effect.phase).toEqual({
      representation: { kind: 'complete' }, executableLowering: { kind: 'complete' },
    })
    expect(grammar.Entry!.parse('az', 0, { trackLines: false } as ParseContext))
      .toMatchObject({ ok: false, expected: ['"x"', '"b"'] })
    const program = encodeTable(grammar)
    for (const entry of [
      execRules(program).Entry!,
      tableRules({ ...program, asm: [] }).Entry!,
      tableRules(program).Entry!,
    ]) {
      expect(run(entry, 'az')).toMatchObject({ ok: false, expected: ['"x"'] })
    }
  })

  it('projects routed dispatch through the Stage-A route authority without copied flags', () => {
    const grammar = dispatch(
      token(regex(/[a-z]+/)),
      when('x', sequence(routed(), literal('!'))),
    )
    const inventory = c2([grammar])
    const authority = authorityFor(inventory)
    expect(authority).toMatchObject({ atom: 'dispatch', orderedRouteIds: [0] })
    const effect = effectFor(inventory)
    expect(effect.phase).toEqual({
      representation: { kind: 'complete' }, executableLowering: { kind: 'complete' },
    })
    expect(inventory.decisions[0]?.routeUsesRouted).toEqual([true])
    expect(effect).toMatchObject({ readerMask: 0b111, variantMask: 0b11_1111 })
    // C2 references the final Stage-A classifier and route identities. It must
    // not mint another predicate spelling or construction-time usesRouted bit;
    // the single source-order policy lives on the Stage-A decision site.
    expect(JSON.stringify({ authority, effect })).not.toMatch(/predicate|usesRouted/)
    const noRouteExpected = inventory.decisionEffectPlan
      .decisionExpectedAuthorities[authority.atom === 'dispatch'
        ? authority.noRouteExpectedAuthorityId : -1]
    expect(noRouteExpected?.values).toEqual(['"x"'])
  })

  it('records every greedyClassify operand: super arm, spelling-to-arm map, and transform projection', () => {
    const grammar = choice(
      transform(literal('if'), value => `kw:${value}`),
      transform(transform(literal('for'), value => value), value => `kw:${value}`),
      regex(/[a-z]+/),
    )
    const inventory = c2([grammar])
    const authority = authorityFor(inventory)
    expect(authority.atom).toBe('choice')
    if (authority.atom !== 'choice' || authority.mode.kind !== 'classify') {
      expect(authority).toMatchObject({ atom: 'choice', mode: { kind: 'classify' } })
      return
    }
    expect(authority.mode.superArmId).toBe(2)
    expect(inventory.decisionEffectPlan.classifySpellingMaps[authority.mode.spellingMapAuthorityId]).toEqual({
      id: authority.mode.spellingMapAuthorityId,
      entries: [{ spelling: 'if', armId: 0 }, { spelling: 'for', armId: 1 }],
    })
    expect(inventory.decisionEffectPlan.classifyProjectionPlans[authority.mode.projectionAuthorityId]).toMatchObject({
      id: authority.mode.projectionAuthorityId,
      entries: [{ armId: 0, transformCount: 1 }, { armId: 1, transformCount: 2 }],
    })
    const projections = inventory.decisionEffectPlan.classifyProjectionPlans[authority.mode.projectionAuthorityId]!
    expect(projections.entries.flatMap(entry => entry.transformIds)).toEqual([0, 1, 2])
    expect(inventory.decisionEffectPlan.decisionCallbackAuthorities).toHaveLength(3)
    const projected = projections.entries[1]!.transformIds.reduce(
      (value, id) => inventory.decisionEffectPlan.decisionCallbackAuthorities[id]!
        .callback(value, { start: 0, end: 3 }),
      'for' as unknown,
    )
    expect(projected).toBe('kw:for')
    const expected = inventory.decisionEffectPlan
      .decisionExpectedAuthorities[authority.staticMissExpectedAuthorityId!]
    expect(expected?.values).toEqual(['/[a-z]+/'])
    const firstMiss = grammar.parse('1', 0, { trackLines: false } as ParseContext)
    const secondMiss = grammar.parse('1', 0, { trackLines: false } as ParseContext)
    expect(firstMiss).toMatchObject({ ok: false, expected: ['/[a-z]+/'] })
    expect(secondMiss).toMatchObject({ ok: false, expected: ['/[a-z]+/'] })
    if (!firstMiss.ok && !secondMiss.ok) {
      expect(firstMiss.expected).not.toBe(secondMiss.expected)
      firstMiss.expected.push('mutated')
      expect(secondMiss.expected).toEqual(['/[a-z]+/'])
    }
    expect(effectFor(inventory).phase.executableLowering).toEqual({
      kind: 'gap', reason: expect.stringContaining('classified transform'),
    })
  })

  it('projects longest-literal order through all three readers before pricing', () => {
    const grammar = choice(literal('a'), literal('abc'), literal('ab'))
    const inventory = c2([grammar])
    const authority = authorityFor(inventory)
    expect(authority.atom).toBe('choice')
    if (authority.atom !== 'choice' || authority.mode.kind !== 'longest') {
      expect(authority).toMatchObject({ atom: 'choice', mode: { kind: 'longest' } })
      return
    }
    expect(inventory.decisionEffectPlan.choiceExecutionOrders[authority.mode.orderAuthorityId]).toEqual({
      id: authority.mode.orderAuthorityId,
      armIds: [1, 2, 0],
    })
    const expected = inventory.decisionEffectPlan
      .decisionExpectedAuthorities[authority.staticMissExpectedAuthorityId!]
    expect(expected?.values).toEqual(['"abc"', '"ab"', '"a"'])
    const firstMiss = grammar.parse('z', 0, { trackLines: false } as ParseContext)
    const secondMiss = grammar.parse('z', 0, { trackLines: false } as ParseContext)
    expect(firstMiss).toMatchObject({ ok: false, expected: ['"abc"', '"ab"', '"a"'] })
    expect(secondMiss).toMatchObject({ ok: false, expected: ['"abc"', '"ab"', '"a"'] })
    if (!firstMiss.ok && !secondMiss.ok) {
      expect(firstMiss.expected).not.toBe(secondMiss.expected)
      firstMiss.expected.reverse()
      expect(secondMiss.expected).toEqual(['"abc"', '"ab"', '"a"'])
    }
    const effect = effectFor(inventory)
    expect(effect.phase).toEqual({
      representation: { kind: 'complete' }, executableLowering: { kind: 'complete' },
    })
    expect(effect).toMatchObject({
      childBindingProjectionIds: [expect.any(Number), expect.any(Number), expect.any(Number)],
      referenceTemplateId: 12, capturedTemplateId: 13, namedTemplateId: 14,
      readerMask: 0b111, variantMask: 0b11_1111,
      semanticDigest: expect.any(Number),
    })
    expect(effect.semanticDigest).not.toBe(0)
  })

  it('maps one effect to every decision occurrence without authorizing serialization', () => {
    const grammar = sequence(
      choice(literal('a'), regex(/[bc]/)),
      dispatch(token(regex(/[a-z]+/)), when('x', literal('!'))),
    )
    const inventory = c2([grammar])
    expect(inventory.decisionEffectPlan.finalDecisionAuthorities).toHaveLength(inventory.decisions.length)
    expect(inventory.decisionEffectPlan.decisionEffects).toHaveLength(inventory.decisions.length)
    expect(inventory.decisionEffectPlan.decisionEffects
      .map(effect => effect.decisionSiteId).sort((a, b) => a - b))
      .toEqual(inventory.decisions.map(site => site.siteId).sort((a, b) => a - b))
    expect(inventory.decisionEffectPlan.decisionEffects.every(effect =>
      effect.phase.representation.kind === 'complete')).toBe(true)
    expect(inventory.decisionEffectPlan.decisionEffects.every(effect =>
      effect.phase.executableLowering.kind === 'complete')).toBe(true)
    expect(inventory.capabilityComplete).toBe(false)
    const program = encodeTable({ Entry: grammar }) as unknown as Record<string, unknown>
    expect(Object.keys(program).filter(key => /decision|choiceClass|classify/i.test(key))).toEqual([])
  })

  it('keeps ordered gate/autoNot/commit expected accumulation dynamic and source-exact', () => {
    const gateEvents: string[] = []
    const gated = choice(
      { gate: () => { gateEvents.push('false'); return false }, combinator: literal('a') },
      { gate: () => { gateEvents.push('true'); return true }, combinator: regex(/[ab]/) },
    )
    const gatedInventory = c2([gated])
    const gatedAuthority = authorityFor(gatedInventory)
    expect(gatedAuthority).toMatchObject({ atom: 'choice', mode: { kind: 'ordered' } })
    if (gatedAuthority.atom !== 'choice') return
    expect(gatedAuthority.staticMissExpectedAuthorityId).toBeUndefined()
    const gatedMiss = gated.parse('z', 0, { trackLines: false } as ParseContext)
    expect(gateEvents).toEqual(['false', 'true'])
    expect(gatedMiss).toMatchObject({ ok: false, expected: ['/[ab]/'] })
    expect(() => choice(
      { gate: () => { throw new Error('gate boom') }, combinator: literal('a') },
      regex(/[ab]/),
    ).parse('z', 0, { trackLines: false } as ParseContext)).toThrow('gate boom')

    const autoNot = choice(
      transform(literal('if'), () => 'IF'),
      transform(literal('iffy'), () => 'IFFY'),
      transform(sequence(literal('z'), literal('z')), () => 'ZZ'),
    )
    const autoInventory = c2([autoNot])
    const autoAuthority = authorityFor(autoInventory)
    expect(autoAuthority.atom === 'choice' && autoAuthority.staticMissExpectedAuthorityId).toBeUndefined()
    expect(autoNot.parse('iffy', 0, { trackLines: false } as ParseContext))
      .toMatchObject({ ok: true, value: 'IFFY' })
    expect(autoInventory.decisionEffectPlan.decisionAutoNotAuthorities).toContainEqual({
      id: expect.any(Number), checks: [{ kind: 'startsWith', value: 'fy' }],
    })

    const committed: Combinator<unknown> = {
      _tag: 'committed-test', _meta: literal('b')._meta,
      _def: { tag: 'unknown' },
      parse(_input, pos) {
        return { ok: false, expected: ['committed'], span: { start: pos + 1, end: pos + 1 }, committed: true }
      },
    }
    const committedChoice = choice(literal('a'), committed, literal('c'))
    const committedInventory = c2([committedChoice])
    const committedAuthority = authorityFor(committedInventory)
    expect(committedAuthority.atom === 'choice' && committedAuthority.staticMissExpectedAuthorityId)
      .toBeUndefined()
    const committedMiss = committedChoice.parse('z', 0, { trackLines: false } as ParseContext)
    expect(committedMiss).toMatchObject({
      ok: false, expected: ['"a"', 'committed'], span: { start: 1, end: 1 }, committed: true,
    })
    expect(committedInventory.decisionEffectPlan.decisionChildEffects.map(child =>
      committedInventory.decisionEffectPlan.decisionExpectedAuthorities[child.expectedAuthorityId]!.values))
      .toEqual([['"a"'], [], ['"c"']])

    const duplicate = choice(regex(/a/), regex(/a/), regex(/b/))
    const first = duplicate.parse('z', 0, { trackLines: false } as ParseContext)
    const second = duplicate.parse('z', 0, { trackLines: false } as ParseContext)
    expect(first).toMatchObject({ ok: false, expected: ['/a/', '/a/', '/b/'] })
    expect(second).toMatchObject({ ok: false, expected: ['/a/', '/a/', '/b/'] })
    if (!first.ok && !second.ok) {
      expect(first.expected).not.toBe(second.expected)
      first.expected.pop()
      expect(second.expected).toEqual(['/a/', '/a/', '/b/'])
    }
  })

  it('makes C2 inventory omission and callback mutation fail the independent closure audit', () => {
    const grammar = choice(
      transform(literal('if'), value => `kw:${value}`),
      regex(/[a-z]+/),
    )
    const inventory = c2([grammar])
    expect(() => assertLexicalCapabilityClosure([grammar], {
      ...inventory,
      decisionEffectPlan: {
        ...inventory.decisionEffectPlan,
        decisionEffects: inventory.decisionEffectPlan.decisionEffects.slice(1),
      },
    })).toThrow(/census is incomplete/)
    expect(() => assertLexicalCapabilityClosure([grammar], {
      ...inventory,
      decisionEffectPlan: {
        ...inventory.decisionEffectPlan,
        decisionEffects: inventory.decisionEffectPlan.decisionEffects.map((effect, index) =>
          index === 0 ? { ...effect, semanticDigest: effect.semanticDigest ^ 1 } : effect),
      },
    })).toThrow(/census is incomplete/)
    expect(() => assertLexicalCapabilityClosure([grammar], {
      ...inventory,
      decisionEffectPlan: {
        ...inventory.decisionEffectPlan,
        decisionCallbackAuthorities: inventory.decisionEffectPlan.decisionCallbackAuthorities
          .map((entry, index) => index === 0
            ? { ...entry, callback: (value: unknown) => value as never } : entry),
      },
    })).toThrow(/census is incomplete/)
  })
})
