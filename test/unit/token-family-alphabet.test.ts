import { describe, expect, it } from 'vitest'
import {
  assertLexicalCapabilityClosure, collectAlphabet, collectLexicalAlphabet,
  compatibleLexicalOutcomes, selectedLexicalOutcome,
  type LexicalTokenClassifier,
} from '../../src/compiler/token-alphabet.ts'
import type { Combinator, ParserDef } from '../../src/types.ts'
import {
  adjacent, attempt, choice, dispatch, endsWith, expect as expectCombinator, field, gate, label, leaf,
  keywords, literal, makeWhen, many, matches, node, otherwise, optional, parse, parser, ref, regex, routed, scanTo,
  sepBy, sequence, startsWith, token, transform, when, withCtx,
} from '../../src/index.ts'

function synthetic<T>(inner: Combinator<T>, def: ParserDef): Combinator<T> {
  return { ...inner, _def: def }
}

describe('derived lexical-token families', () => {
  it('censuses atomic token ownership and independently reachable terminals', () => {
    const shared = regex(/[a-z]+/)
    const privateSuffix = literal('(')
    const head = token(sequence(shared, optional(privateSuffix)))
    const root = sequence(literal('!'), shared, head)

    const alphabet = collectLexicalAlphabet([root])
    expect(alphabet.capabilities.map(site => ({
      id: site.id, atom: site.atom, key: site.semanticKey, status: site.status.kind,
    }))).toEqual([
      { id: 0, atom: 'terminal', key: 'L\u0000!\u0000', status: 'complete' },
      { id: 1, atom: 'terminal', key: 'R\u0000[a-z]+\u0000', status: 'complete' },
      {
        id: 2,
        atom: 'token',
        key: expect.stringContaining('"kind":"sequence"'),
        status: 'gap',
      },
    ])
    expect(alphabet.capabilities).not.toContainEqual(expect.objectContaining({ parser: privateSuffix }))
    expect(alphabet.capabilityComplete).toBe(false)
  })

  it('fails the final-graph census when a valid candidate is hidden', () => {
    const root = sequence(literal('!'), token(regex(/[a-z]+/)))
    const alphabet = collectLexicalAlphabet([root])
    expect(() => assertLexicalCapabilityClosure([root], {
      capabilities: alphabet.capabilities.slice(1),
    })).toThrow('lexical capability census is incomplete')

    // RED provenance: before standalone primitives were enumerated, inserting
    // this leading literal did not change the token-only census or its ids.
    const withoutPrefix = collectLexicalAlphabet([token(regex(/[a-z]+/))])
    expect(withoutPrefix.capabilities.map(site => [site.id, site.atom]))
      .toEqual([[0, 'token']])
    expect(alphabet.capabilities.map(site => [site.id, site.atom]))
      .toEqual([[0, 'terminal'], [1, 'token']])
  })

  it('includes final choice and dispatch decisions outside owned token bodies', () => {
    const ownedChoice = choice(literal('a'), literal('b'))
    const head = token(ownedChoice)
    const routedChoice = choice(
      dispatch(head, when('a', literal('x')), otherwise(literal('y'))),
      literal('!'),
    )
    const alphabet = collectLexicalAlphabet([routedChoice])
    expect(alphabet.capabilities.map(site => site.atom)).toEqual([
      'choice', 'dispatch', 'token', 'terminal', 'terminal', 'terminal',
    ])
    expect(alphabet.capabilities.filter(site => site.parser === ownedChoice)).toHaveLength(0)
    expect(alphabet.capabilityComplete).toBe(false)
  })

  it('catalogues token() as one range and keeps its child terminals private', () => {
    const identifier = regex(/[a-z-]+/i)
    const open = literal('(')
    const identOrFunction = token(sequence(identifier, optional(open)))
    const fold = makeWhen({ caseInsensitive: true })
    const value = dispatch(
      identOrFunction,
      fold(['url(', 'calc('], literal('known')),
      when(endsWith('('), literal('generic')),
      otherwise(transform(literal(''), () => 'ident')),
    )

    const alphabet = collectLexicalAlphabet([value])
    const primitiveKernels = collectAlphabet([value])
    const tokenDef = identOrFunction._def
    if (tokenDef.tag !== 'token') throw new Error('test setup: expected token')

    expect(alphabet.families).toHaveLength(1)
    expect(alphabet.sites).toHaveLength(1)
    expect(alphabet.sites[0]).toMatchObject({
      parser: identOrFunction,
      body: tokenDef.parser,
      familyId: alphabet.families[0]!.id,
    })
    expect(alphabet.familyIdOf.get(identOrFunction)).toBe(alphabet.families[0]!.id)

    // The regex and optional '(' are recognition machinery for ONE source
    // range. They remain kernel terminals; neither becomes a published token.
    expect(primitiveKernels.originOf.has(
      primitiveKernels.byKey.get('R\u0000[a-z-]+\u0000i')!,
    )).toBe(true)
    expect(primitiveKernels.originOf.has(
      primitiveKernels.byKey.get('L\u0000(\u0000')!,
    )).toBe(true)
    expect(alphabet.recognizers).toHaveLength(1)
    expect(alphabet.families[0]!.recognizerId).toBe(alphabet.recognizers[0]!.id)
    expect(alphabet.sites).not.toContainEqual(expect.objectContaining({ parser: identifier }))
    expect(alphabet.sites).not.toContainEqual(expect.objectContaining({ parser: open }))
    expect(Object.keys(alphabet)).not.toContain('primitiveKernels')

    expect(alphabet.classifiers).toHaveLength(1)
    const classifier = alphabet.classifiers[0]!
    expect(classifier.familyId).toBe(alphabet.families[0]!.id)
    expect(classifier.outcomes.map(outcome => outcome.match)).toEqual([
      { kind: 'exact', values: ['url('], caseInsensitive: true },
      { kind: 'exact', values: ['calc('], caseInsensitive: true },
      { kind: 'endsWith', value: '(', caseInsensitive: false },
      {
        kind: 'otherwise',
        excluding: [
          { kind: 'exact', values: ['url('], caseInsensitive: true },
          { kind: 'exact', values: ['calc('], caseInsensitive: true },
          { kind: 'endsWith', value: '(', caseInsensitive: false },
        ],
      },
    ])
    expect(new Set(classifier.outcomes.map(outcome => outcome.id)).size).toBe(4)

    const exactId = classifier.outcomes[0]!.id
    const functionOpenId = classifier.outcomes[2]!.id
    const identId = classifier.outcomes[3]!.id
    for (const [input, end, ids] of [
      ['foo', 3, [identId]],
      ['foo(', 4, [functionOpenId]],
      ['URL(', 4, [exactId, functionOpenId]],
    ] as const) {
      const result = parse(identOrFunction, input)
      expect(result).toMatchObject({ ok: true, span: { start: 0, end } })
      expect(compatibleLexicalOutcomes(classifier, input, 0, end)).toEqual(ids)
    }
  })

  it('resolves a lazy selector to the existing token family without minting a twin', () => {
    const identOrFunction = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const selector = ref<string>()
    selector.define(identOrFunction)
    const value = dispatch(
      selector,
      when(endsWith('('), literal('call')),
      otherwise(literal('ident')),
    )

    const alphabet = collectLexicalAlphabet([value])

    expect(alphabet.families).toHaveLength(1)
    expect(alphabet.sites).toHaveLength(1)
    expect(alphabet.classifiers).toHaveLength(1)
    expect(alphabet.classifiers[0]!.familyId).toBe(alphabet.families[0]!.id)
    expect(alphabet.classifiers[0]!.selectorEffects).toBe(true)
  })

  it('keeps classifiers site-local when one family has different downstream routes', () => {
    const head = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const first = dispatch(head, when(endsWith('('), literal('a')), otherwise(literal('b')))
    const second = dispatch(head, when('url(', literal('c')), otherwise(literal('d')))
    const sameAsFirst = dispatch(head, when(endsWith('('), literal('e')), otherwise(literal('f')))

    const alphabet = collectLexicalAlphabet([sequence(first, second, sameAsFirst)])

    expect(alphabet.families).toHaveLength(1)
    expect(alphabet.classifiers).toHaveLength(3)
    expect(alphabet.classifiers.every((site: LexicalTokenClassifier) =>
      site.familyId === alphabet.families[0]!.id)).toBe(true)
    expect(new Set(alphabet.classifiers.flatMap(site => site.outcomes.map(outcome => outcome.id))).size).toBe(4)
    expect(alphabet.classifiers[0]!.outcomes.map(outcome => outcome.id)).toEqual(
      alphabet.classifiers[2]!.outcomes.map(outcome => outcome.id),
    )
  })

  it('canonicalizes Jess-shaped compatible predicates without collapsing context', () => {
    const head = token(sequence(regex(/[a-z]+/i), optional(literal('('))))
    const fold = makeWhen({ caseInsensitive: true })
    const value = dispatch(
      head,
      fold(['URL(', 'var(', 'calc('], literal('value-exact')),
      when(endsWith('('), literal('value-generic')),
      otherwise(literal('value-ident')),
    )
    const header = dispatch(
      head,
      fold('url(', literal('header-exact')),
      when(endsWith('('), literal('header-generic')),
      otherwise(literal('header-ident')),
    )
    const exactOnly = dispatch(
      head,
      fold('url(', literal('exact-only')),
      otherwise(literal('broader-fallback')),
    )
    const priority = dispatch(
      head,
      when(startsWith('foo'), literal('prefix-first')),
      when(endsWith('('), literal('function-second')),
      otherwise(literal('priority-fallback')),
    )
    const otherHead = token(sequence(regex(/[0-9]+/), optional(literal('('))))
    const otherFamily = dispatch(
      otherHead,
      when(endsWith('('), literal('number-function')),
      otherwise(literal('number-ident')),
    )

    const alphabet = collectLexicalAlphabet([value, header, exactOnly, priority, otherFamily])
    const [valueSite, headerSite, exactOnlySite, prioritySite, otherSite] = alphabet.classifiers
    expect(valueSite!.outcomes[0]!.id).toBe(headerSite!.outcomes[0]!.id)
    expect(valueSite!.routes[0]).toMatchObject({
      index: 0,
      acceptedIds: valueSite!.outcomes.slice(0, 3).map(outcome => outcome.id),
    })
    expect(headerSite!.routes[0]!.acceptedIds).toEqual([headerSite!.outcomes[0]!.id])
    expect(valueSite!.outcomes[3]!.id).toBe(headerSite!.outcomes[1]!.id)
    expect(valueSite!.outcomes[4]!.id).toBe(headerSite!.outcomes[2]!.id)
    expect(valueSite!.outcomes[4]!.id).not.toBe(exactOnlySite!.outcomes[1]!.id)
    expect(valueSite!.outcomes[3]!.id).not.toBe(otherSite!.outcomes[0]!.id)

    const valueIds = compatibleLexicalOutcomes(valueSite!, 'URL(', 0, 4)
    expect(valueIds).toEqual([valueSite!.outcomes[0]!.id, valueSite!.outcomes[3]!.id])
    expect(selectedLexicalOutcome(valueSite!, 'URL(', 0, 4)).toMatchObject({
      outcomeId: valueSite!.outcomes[0]!.id,
      route: { index: 0, acceptedIds: valueSite!.routes[0]!.acceptedIds },
    })
    expect(parse(value, 'URL(value-exact')).toMatchObject({
      ok: true,
      value: ['URL(', 'value-exact'],
    })
    expect(parse(value, 'URL(value-generic')).toMatchObject({ ok: false, committed: true })

    const priorityIds = compatibleLexicalOutcomes(prioritySite!, 'foo(', 0, 4)
    expect(priorityIds).toEqual([prioritySite!.outcomes[0]!.id, prioritySite!.outcomes[1]!.id])
    expect(selectedLexicalOutcome(prioritySite!, 'foo(', 0, 4)).toMatchObject({
      outcomeId: prioritySite!.outcomes[0]!.id,
      route: { index: 0 },
    })
    expect(parse(priority, 'foo(prefix-first')).toMatchObject({
      ok: true,
      value: ['foo(', 'prefix-first'],
    })
  })

  it('canonicalizes CI fixed matchers and effective regex flags', () => {
    const head = token(regex(/[A-Za-z(]+/))
    const upper = dispatch(
      head,
      when(endsWith('FN('), literal('upper'), { caseInsensitive: true }),
      when(matches(/foo/i), literal('regex-flag')),
      otherwise(literal('upper-fallback')),
    )
    const lower = dispatch(
      head,
      when(endsWith('fn('), literal('lower'), { caseInsensitive: true }),
      when(matches(/foo/), literal('regex-option'), { caseInsensitive: true }),
      otherwise(literal('lower-fallback')),
    )

    const alphabet = collectLexicalAlphabet([upper, lower])

    expect(alphabet.classifiers[0]!.outcomes.map(outcome => outcome.id)).toEqual(
      alphabet.classifiers[1]!.outcomes.map(outcome => outcome.id),
    )
  })

  it('deduplicates compatible IDs without erasing matcher priority or fallback identity', () => {
    const head = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const duplicate = dispatch(
      head,
      when(endsWith('('), literal('first')),
      when(endsWith('('), literal('second')),
      otherwise(literal('duplicate-fallback')),
    )
    const single = dispatch(
      head,
      when(endsWith('('), literal('only')),
      otherwise(literal('single-fallback')),
    )

    const alphabet = collectLexicalAlphabet([duplicate, single])
    const [duplicateSite, singleSite] = alphabet.classifiers

    expect(duplicateSite!.outcomes[0]!.id).toBe(duplicateSite!.outcomes[1]!.id)
    expect(duplicateSite!.routes.slice(0, 2).map(route => route.index)).toEqual([0, 1])
    expect(duplicateSite!.routes[0]!.parser).not.toBe(duplicateSite!.routes[1]!.parser)
    expect(compatibleLexicalOutcomes(duplicateSite!, 'foo(', 0, 4)).toEqual([
      duplicateSite!.outcomes[0]!.id,
    ])
    expect(selectedLexicalOutcome(duplicateSite!, 'foo(', 0, 4)).toMatchObject({
      outcomeId: duplicateSite!.outcomes[0]!.id,
      route: { index: 0, parser: duplicateSite!.routes[0]!.parser },
    })
    expect(parse(duplicate, 'foo(first')).toMatchObject({ ok: true, value: ['foo(', 'first'] })
    expect(duplicateSite!.outcomes[2]!.id).toBe(singleSite!.outcomes[1]!.id)
  })

  it('preserves sticky matcher semantics in global outcome identity', () => {
    const head = token(regex(/[a-z]+/))
    const matcherDispatch = (flags: string): Combinator<unknown> => {
      const fallback = literal('fallback')
      const base = dispatch(head, otherwise(fallback))
      return synthetic(base, {
        tag: 'dispatch',
        selector: head,
        cases: [],
        matchers: [{
          kind: 'matches', value: 'x', flags, parser: literal('matched'), caseInsensitive: false,
        }],
        otherwise: fallback,
      })
    }
    const sticky = matcherDispatch('y')
    const unsticky = matcherDispatch('')

    const alphabet = collectLexicalAlphabet([sticky, unsticky])
    const [stickySite, unstickySite] = alphabet.classifiers

    expect(stickySite!.outcomes[0]!.id).not.toBe(unstickySite!.outcomes[0]!.id)
    expect(compatibleLexicalOutcomes(stickySite!, 'ax', 0, 2)).toEqual([stickySite!.outcomes[1]!.id])
    expect(compatibleLexicalOutcomes(unstickySite!, 'ax', 0, 2)).toEqual([unstickySite!.outcomes[0]!.id])
  })

  it('keeps route identity when parsers are reused and reports no route without a fallback', () => {
    const head = token(regex(/[a-z]+/))
    const sharedBranch = literal('shared')
    const reused = dispatch(
      head,
      when(startsWith('a'), sharedBranch),
      when(endsWith('z'), sharedBranch),
    )
    const routedBranch = sequence(routed(), literal('tail'))
    const routedDispatch = dispatch(
      head,
      when(startsWith('r'), routedBranch),
    )

    const alphabet = collectLexicalAlphabet([reused, routedDispatch])
    const [reusedSite, routedSite] = alphabet.classifiers

    expect(reusedSite!.routes).toHaveLength(2)
    expect(reusedSite!.routes[0]!.parser).toBe(reusedSite!.routes[1]!.parser)
    expect(reusedSite!.routes[0]!.index).not.toBe(reusedSite!.routes[1]!.index)
    expect(selectedLexicalOutcome(reusedSite!, 'middle', 0, 6)).toBeUndefined()
    expect(compatibleLexicalOutcomes(reusedSite!, 'middle', 0, 6)).toEqual([])
    expect(routedSite!.routes[0]).toMatchObject({ index: 0, usesRouted: true })
  })

  it('resolves late-defined routed effects for exact, matcher, and fallback routes', () => {
    const head = token(regex(/[a-z]+/))
    const exactRef = ref<unknown>()
    const matcherRef = ref<unknown>()
    const fallbackRef = ref<unknown>()
    const plainRef = ref<unknown>()
    const classified = dispatch(
      head,
      when('exact', exactRef),
      when(startsWith('match'), matcherRef),
      when('plain', plainRef),
      otherwise(fallbackRef),
    )

    // The route declarations above cached `usesRouted: false`. The referenced
    // branches acquire routed() only after dispatch construction, so metadata
    // must ask the same authoritative graph walk used by execution/encoding.
    exactRef.define(sequence(routed(), literal('exact-tail')))
    matcherRef.define(sequence(routed(), literal('matcher-tail')))
    fallbackRef.define(sequence(routed(), literal('fallback-tail')))
    plainRef.define(literal('plain-tail'))

    const [classifier] = collectLexicalAlphabet([classified]).classifiers
    expect(classifier!.routes.map(route => route.usesRouted)).toEqual([true, false, true, true])
  })

  it('keeps case-sensitive and case-insensitive exact route IDs distinct', () => {
    const head = token(regex(/[A-Za-z]+/))
    const sensitive = dispatch(head, when('URL', literal('sensitive')))
    const insensitive = dispatch(
      head,
      when('URL', literal('insensitive'), { caseInsensitive: true }),
    )

    const alphabet = collectLexicalAlphabet([sensitive, insensitive])

    expect(alphabet.classifiers[0]!.routes[0]!.acceptedIds[0]).not.toBe(
      alphabet.classifiers[1]!.routes[0]!.acceptedIds[0],
    )
  })

  it('reduces grouped exact exclusions value-by-value in fallback identity', () => {
    const head = token(regex(/[a-z(]+/))
    const grouped = dispatch(
      head,
      when(['url(', 'bare'], literal('grouped')),
      when(endsWith('('), literal('function')),
      otherwise(literal('ident')),
    )
    const reduced = dispatch(
      head,
      when('bare', literal('single')),
      when(endsWith('('), literal('other-function')),
      otherwise(literal('other-ident')),
    )

    const alphabet = collectLexicalAlphabet([grouped, reduced])

    expect(alphabet.classifiers[0]!.outcomes[3]!.id).toBe(alphabet.classifiers[1]!.outcomes[2]!.id)
  })

  it('canonicalizes keyword set order and CI spelling', () => {
    const first = token(keywords(['URL', 'calc'], { caseInsensitive: true }))
    const second = token(keywords(['CALC', 'url'], { caseInsensitive: true }))

    const alphabet = collectLexicalAlphabet([first, second])

    expect(alphabet.families).toHaveLength(1)
    expect(alphabet.sites.map(site => site.familyId)).toEqual([
      alphabet.families[0]!.id, alphabet.families[0]!.id,
    ])
  })

  it('canonicalizes CI literal spelling while retaining separate diagnostics', () => {
    const upper = token(literal('URL', { caseInsensitive: true }))
    const lower = token(literal('url', { caseInsensitive: true }))

    const alphabet = collectLexicalAlphabet([upper, lower])

    expect(alphabet.families).toHaveLength(1)
    expect(alphabet.sites.map(site => site.familyId)).toEqual([
      alphabet.families[0]!.id, alphabet.families[0]!.id,
    ])
    expect(alphabet.sites[0]!.diagnosticId).not.toBe(alphabet.sites[1]!.diagnosticId)
  })

  it('suppresses nested token ownership unless the inner token is independently reachable', () => {
    const inner = token(literal('a'))
    const outer = token(sequence(inner, literal('b')))
    const nestedSelector = token(literal('x'))
    const outerDispatch = token(dispatch(
      nestedSelector,
      when('x', literal('tail')),
      otherwise(literal('other')),
    ))

    const ownedOnly = collectLexicalAlphabet([outer, outerDispatch])
    expect(ownedOnly.sites.map(site => site.parser)).toEqual([outer, outerDispatch])
    expect(ownedOnly.familyIdOf.has(inner)).toBe(false)
    expect(ownedOnly.familyIdOf.has(nestedSelector)).toBe(false)
    expect(ownedOnly.classifiers).toHaveLength(0)

    const shared = collectLexicalAlphabet([outer, inner])
    expect(shared.sites.map(site => site.parser)).toEqual([outer, inner])
    expect(shared.familyIdOf.has(inner)).toBe(true)
  })

  it('interns equivalent effect-free token bodies as one canonical recognizer', () => {
    const makeHead = () => token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const first = makeHead()
    const second = makeHead()

    const alphabet = collectLexicalAlphabet([first, second])

    expect(alphabet.families).toHaveLength(1)
    expect(alphabet.sites).toHaveLength(2)
    expect(alphabet.recognizers).toHaveLength(1)
    expect(alphabet.sites.map(site => site.familyId)).toEqual([
      alphabet.families[0]!.id, alphabet.families[0]!.id,
    ])
    expect(alphabet.recognizers[0]!.ir).toMatchObject({
      kind: 'sequence',
      parts: [
        { kind: 'regex', source: '[a-z]+' },
        { kind: 'repeat', min: 0, max: 1, body: { kind: 'literal', value: '(' } },
      ],
    })
  })

  it('gives readable optional composition and an equivalent regex one recognizer spec', () => {
    const readable = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const monolithic = token(regex(/[a-z]+\(?/))

    const alphabet = collectLexicalAlphabet([readable, monolithic])

    expect(alphabet.families).toHaveLength(1)
    expect(alphabet.sites).toHaveLength(2)
    expect(alphabet.recognizers).toHaveLength(1)
    expect(alphabet.sites[0]!.familyId).toBe(alphabet.sites[1]!.familyId)
    expect(alphabet.sites[0]!.diagnosticId).not.toBe(alphabet.sites[1]!.diagnosticId)

    const samples = ['']
    for (let width = 1; width <= 5; width++) {
      const prior = [...samples]
      for (const prefix of prior.filter(value => value.length === width - 1)) {
        for (const char of ['a', 'b', '(', ')']) samples.push(prefix + char)
      }
    }
    for (const input of samples) {
      const readableResult = parse(readable, input)
      const monolithicResult = parse(monolithic, input)
      expect(readableResult.ok, input).toBe(monolithicResult.ok)
      if (readableResult.ok && monolithicResult.ok) {
        expect(readableResult.span.end, input).toBe(monolithicResult.span.end)
        expect(readableResult.value, input).toBe(monolithicResult.value)
      }
    }
  })

  it.each([
    ['/a?a/', () => token(regex(/a?a/)), () => token(sequence(optional(literal('a')), literal('a')))],
    ['/a*a/', () => token(regex(/a*a/)), () => token(sequence(many(literal('a')), literal('a')))],
    ['overlapping alternation/follow', () => token(regex(/(?:a|ab)c/)), () => token(sequence(choice(regex(/a/), regex(/ab/)), literal('c')))],
  ])('does not conflate regex backtracking with possessive PEG: %s', (_name, regexToken, pegToken) => {
    const regexFamily = regexToken()
    const pegFamily = pegToken()
    const alphabet = collectLexicalAlphabet([regexFamily, pegFamily])

    expect(alphabet.sites).toHaveLength(2)
    expect(alphabet.sites[0]!.familyId).not.toBe(alphabet.sites[1]!.familyId)
    if (_name === '/a?a/' || _name === '/a*a/') {
      expect(parse(regexFamily, 'a').ok).toBe(true)
      expect(parse(pegFamily, 'a').ok).toBe(false)
    } else {
      expect(parse(regexFamily, 'abc').ok).toBe(true)
      expect(parse(pegFamily, 'abc').ok).toBe(false)
    }
  })

  it('refuses effectful token bodies instead of silently bypassing their semantics', () => {
    const recovered = regex(/[a-z]+/)
    const cases = [
      [token(sequence(literal('a'), gate(() => true))), 'guard is dynamic'],
      [token(transform(regex(/[a-z]+/), value => value.toUpperCase())), 'transform is effectful'],
      [token(expectCombinator(regex(/[a-z]+/), 'identifier')), 'expect changes diagnostics'],
      [token(attempt(regex(/[a-z]+/))), 'attempt changes commitment'],
      [token(field('name', regex(/[a-z]+/))), 'field is effectful'],
      [token(withCtx({ mode: 'value' }, regex(/[a-z]+/))), 'withCtx is dynamic'],
      [token(node('Name', regex(/[a-z]+/))), 'node is effectful'],
      [token(leaf(regex(/[a-z]+/), value => value)), 'leaf is effectful'],
      [token(label('identifier', regex(/[a-z]+/))), 'label changes diagnostics'],
      [token(synthetic(recovered, { tag: 'recover', parser: recovered, sentinel: literal(';') })), 'recover is effectful'],
      [token(sequence(literal('a'), adjacent(), literal('b'))), 'adjacency depends on parser state'],
      [token(dispatch(regex(/[a-z]+/), otherwise(literal('tail')))), 'nested dispatch has semantic outcomes'],
      [token(routed(regex(/[a-z]+/))), 'routed depends on an outer dispatch'],
      [token(scanTo(literal(';'))), 'scanTo is not a lexical run'],
      [token(sepBy(regex(/[a-z]+/), literal(','))), 'separated repetition is not a lexical run'],
      [token(parser({ trivia: regex(/\s+/) }, regex(/[a-z]+/))), 'token body has a trivia-bearing scope'],
      [token(parser({ trackLines: true }, regex(/[a-z]+/))), 'token body has line-tracking effects'],
    ] as const

    const alphabet = collectLexicalAlphabet(cases.map(([parser]) => parser))
    expect(alphabet.families).toHaveLength(0)
    expect(alphabet.sites).toHaveLength(cases.length)
    expect(alphabet.recognizers).toHaveLength(0)
    expect(alphabet.diagnostics).toHaveLength(0)
    for (let i = 0; i < cases.length; i++) {
      expect(alphabet.sites[i]).toMatchObject({ parser: cases[i]![0], refusal: cases[i]![1] })
      expect(alphabet.sites[i]).not.toHaveProperty('recognizerId')
    }
  })

  it('does not inspect through an effectful dispatch-selector wrapper', () => {
    const head = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const wrapped = label('identifier or function', head)
    const parser = dispatch(wrapped, when(endsWith('('), literal('call')), otherwise(literal('ident')))

    const alphabet = collectLexicalAlphabet([parser])

    expect(alphabet.families).toHaveLength(1)
    expect(alphabet.sites).toHaveLength(1)
    expect(alphabet.classifiers).toHaveLength(0)
  })

  it('refuses nullable token publication and non-progressing repeat kernels', () => {
    const nullableToken = token(optional(literal('a')))
    const nullableRepeatBody = token(sequence(many(optional(literal('a'))), literal('b')))

    const alphabet = collectLexicalAlphabet([nullableToken, nullableRepeatBody])

    expect(alphabet.families).toHaveLength(0)
    expect(alphabet.sites).toMatchObject([
      { parser: nullableToken, refusal: 'token body may match empty' },
      { parser: nullableRepeatBody, refusal: 'repeat body may not make progress' },
    ])
  })
})
