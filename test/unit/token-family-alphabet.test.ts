import { describe, expect, it } from 'vitest'
import {
  assertLexicalCapabilityClosure, collectAlphabet, collectLexicalAlphabet,
  compatibleLexicalOutcomes, selectedLexicalOutcome, winnerWrapsReference,
  type LexicalTokenClassifier,
} from '../../src/compiler/token-alphabet.ts'
import type { Combinator, ParserDef } from '../../src/types.ts'
import { composedCoverageRules } from '../../src/compiler/linker.ts'
import {
  adjacent, attempt, balanced, choice, compose, dispatch, endsWith, expect as expectCombinator, field, gate, label, leaf,
  keywords, literal, makeWhen, many, matches, node, not, otherwise, optional, parse, parser, ref, regex, routed, rules, scanTo,
  run, sepBy, sequence, startsWith, token, transform, when, withCtx,
} from '../../src/index.ts'

function synthetic<T>(inner: Combinator<T>, def: ParserDef): Combinator<T> {
  return { ...inner, _def: def }
}

type OracleContext = {
  trivia: Combinator<unknown> | undefined
  scanSkip: readonly Combinator<unknown>[]
  trackLines: boolean
  captureTrivia: boolean
  rootCapture: boolean
  dynamicState: boolean
}

function sameOracleContext(a: OracleContext, b: OracleContext): boolean {
  return a.trivia === b.trivia
    && a.trackLines === b.trackLines
    && a.captureTrivia === b.captureTrivia
    && a.rootCapture === b.rootCapture
    && a.dynamicState === b.dynamicState
    && a.scanSkip.length === b.scanSkip.length
    && a.scanSkip.every((entry, index) => entry === b.scanSkip[index])
}

const isCombinator = (value: unknown): value is Combinator<unknown> =>
  value !== null && typeof value === 'object' && '_def' in value && 'parse' in value

/** Independent raw-ParserDef reader: deliberately does not use tokenChildren(). */
function rawDefEdges(parser: Combinator<unknown>): Array<{ label: string; parser: Combinator<unknown> }> {
  const def = parser._def as unknown as Record<string, unknown>
  const out: Array<{ label: string; parser: Combinator<unknown> }> = []
  const read = (value: unknown, label: string, depth: number): void => {
    if (isCombinator(value)) { out.push({ label, parser: value }); return }
    if (depth >= 2 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) read(value[i], `${label}[${i}]`, depth + 1)
      return
    }
    for (const key of Object.keys(value).sort()) {
      read((value as Record<string, unknown>)[key], `${label}.${key}`, depth + 1)
    }
  }
  for (const key of Object.keys(def).filter(key => key !== 'tag').sort()) read(def[key], key, 0)
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

function independentCapabilityOracle(
  roots: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  resolve: (name: string) => Combinator<unknown> | undefined,
  omitWinner?: string,
): {
  rows: Array<{ atom: string; parser: Combinator<unknown>; context: OracleContext; contextKey: string; path: string }>
  edges: number
} {
  const ids = new Map<Combinator<unknown>, number>()
  const id = (parser: Combinator<unknown>): number => {
    const prior = ids.get(parser)
    if (prior !== undefined) return prior
    const next = ids.size
    ids.set(parser, next)
    return next
  }
  const contextKey = (ctx: OracleContext): string =>
    `${ctx.trivia === undefined ? -1 : id(ctx.trivia)}/${ctx.scanSkip.map(id).join(',')}`
    + `/${ctx.trackLines ? 1 : 0}/${ctx.captureTrivia ? 1 : 0}/${ctx.rootCapture ? 1 : 0}`
  const seen = new Set<string>()
  const rows = new Map<string, {
    atom: string
    parser: Combinator<unknown>
    context: OracleContext
    contextKey: string
    path: string
  }>()
  let edges = 0
  const visit = (parser: Combinator<unknown>, context: OracleContext, path: string): void => {
    const outer = contextKey(context)
    const state = `${id(parser)}\u0000${outer}`
    const tag = parser._def.tag
    const atom = tag === 'literal' || tag === 'keywords' || tag === 'regex'
      ? 'terminal'
      : tag === 'token' || tag === 'choice' || tag === 'dispatch' ? tag : undefined
    if (atom !== undefined) {
      const key = `${id(parser)}\u0000${outer}`
      const prior = rows.get(key)
      if (prior === undefined) rows.set(key, { atom, parser, context, contextKey: outer, path })
      else if (path < prior.path) prior.path = path
      if (atom === 'token') return
    }
    if (seen.has(state)) return
    seen.add(state)
    let childContext = context
    const def = parser._def
    if (def.tag === 'grammar') childContext = {
      ...context,
      trivia: def.clearTrivia ? undefined : (def.triviaParser ?? context.trivia),
      trackLines: context.trackLines || def.trackLines,
      captureTrivia: context.captureTrivia || def.captureTrivia === true,
      rootCapture: context.rootCapture || def.rootCapture === 'opaque',
    }
    else if (def.tag === 'withCtx') childContext = { ...context, dynamicState: true }
    let children: Array<{ label: string; parser: Combinator<unknown> }>
    if (def.tag === 'lazy') {
      const name = (parser as Combinator<unknown> & { _ruleName?: string })._ruleName
      let target = name === undefined ? undefined : resolve(name)
      if (target !== undefined) {
        let current = target
        const seenWrappers = new Set<Combinator<unknown>>()
        while (!seenWrappers.has(current)) {
          if (current === parser) { target = undefined; break }
          seenWrappers.add(current)
          const currentDef = current._def
          if (currentDef.tag !== 'grammar' && currentDef.tag !== 'trivia') break
          current = currentDef.parser
        }
      }
      if (target === undefined) {
        try { target = def.thunk() } catch { target = undefined }
      }
      children = target === undefined || name === omitWinner ? [] : [{ label: `winner:${name ?? '?'}`, parser: target }]
    } else children = rawDefEdges(parser)
    for (const edge of children) { edges++; visit(edge.parser, childContext, `${path}/${edge.label}`) }
  }
  for (const [name, root] of [...roots].sort((a, b) => a[0].localeCompare(b[0]))) visit(root, {
    trivia: root._meta.grammarTrivia,
    scanSkip: root._meta.grammarScanSkip ?? [],
    trackLines: root._meta.grammarTrackLines === true,
    captureTrivia: false,
    rootCapture: false,
    dynamicState: false,
  }, `rule:${name}`)
  return { rows: [...rows.values()], edges }
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
      { id: 0, atom: 'terminal', key: 'L\u0000!\u0000', status: 'gap' },
      { id: 1, atom: 'terminal', key: 'R\u0000[a-z]+\u0000', status: 'gap' },
      {
        id: 2,
        atom: 'token',
        key: expect.stringContaining('"kind":"sequence"'),
        status: 'gap',
      },
    ])
    expect(alphabet.capabilities).not.toContainEqual(expect.objectContaining({ parser: privateSuffix }))
    expect(alphabet.capabilities[0]!.obligations).toMatchObject({
      recognition: { kind: 'complete' },
      diagnosticsAndEffects: { kind: 'complete' },
      consumptionAndMaterialization: { kind: 'complete' },
      supportedVariants: { kind: 'complete' },
      bindingAndReachability: { kind: 'gap' },
    })
    expect(alphabet.capabilities[0]!.obligations.bindingAndReachability)
      .toMatchObject({ kind: 'gap', reason: expect.stringContaining('fixed-tuple') })
    expect(alphabet.capabilities[2]!.obligations).toMatchObject({
      recognition: { kind: 'complete' },
      diagnosticsAndEffects: { kind: 'gap' },
      consumptionAndMaterialization: { kind: 'gap' },
      supportedVariants: { kind: 'gap' },
      bindingAndReachability: { kind: 'gap' },
    })
    expect(alphabet.capabilityComplete).toBe(false)
  })

  it('fails the final-graph census when a valid candidate is hidden', () => {
    const root = sequence(literal('!'), token(regex(/[a-z]+/)))
    const alphabet = collectLexicalAlphabet([root])
    expect(() => assertLexicalCapabilityClosure([root], {
      capabilities: alphabet.capabilities.slice(1),
      capabilityLanguages: alphabet.capabilityLanguages,
      bindingEdges: alphabet.bindingEdges,
    })).toThrow('lexical capability census is incomplete')

    // RED provenance: before standalone primitives were enumerated, inserting
    // this leading literal did not change the token-only census or its ids.
    const withoutPrefix = collectLexicalAlphabet([token(regex(/[a-z]+/))])
    expect(withoutPrefix.capabilities.map(site => [site.id, site.atom]))
      .toEqual([[0, 'token']])
    expect(alphabet.capabilities.map(site => [site.id, site.atom]))
      .toEqual([[0, 'terminal'], [1, 'token']])

    const changed = alphabet.capabilities.map((site, index) => index === 0 ? {
      ...site,
      obligations: {
        ...site.obligations,
        bindingAndReachability: { kind: 'complete' } as const,
      },
    } : site)
    expect(() => assertLexicalCapabilityClosure([root], {
      capabilities: changed,
      capabilityLanguages: alphabet.capabilityLanguages,
      bindingEdges: alphabet.bindingEdges,
    }))
      .toThrow('lexical capability census is incomplete')
    // RED provenance: before obligation records were part of the stable
    // signature, changing one obligation silently passed the closure check.
  })

  it('keeps context occurrences and fixed incoming binding edges independent', () => {
    const shared = token(literal('x'))
    const whitespace = regex(/ +/)
    const root = choice(
      parser({ trivia: whitespace }, shared),
      parser({ trivia: null }, shared),
    )
    const alphabet = collectLexicalAlphabet([root])
    const oracle = independentCapabilityOracle([['Root', root]], () => undefined)
    expect(alphabet.capabilities).toHaveLength(oracle.rows.length)
    for (const expected of oracle.rows) {
      expect(alphabet.capabilities.filter(actual =>
        actual.atom === expected.atom
        && actual.parser === expected.parser
        && sameOracleContext(expected.context, {
          trivia: actual.context.trivia,
          scanSkip: actual.context.scanSkip,
          trackLines: actual.context.trackLines,
          captureTrivia: actual.context.captureTrivia,
          rootCapture: actual.context.opaqueRootCapture,
          dynamicState: actual.context.dynamicState,
        }))).toHaveLength(1)
    }
    const occurrences = alphabet.capabilities.filter(site => site.parser === shared)
    expect(occurrences).toHaveLength(2)
    expect(new Set(occurrences.map(site => site.contextKey)).size).toBe(2)
    expect(new Set(occurrences.map(site => site.languageId)).size).toBe(1)
    expect(alphabet.bindingEdges.filter(edge => edge.childTag === 'token')).toHaveLength(2)

    const repeated = collectLexicalAlphabet([choice(shared, shared)])
    expect(repeated.capabilities.filter(site => site.parser === shared)).toHaveLength(1)
    expect(repeated.bindingEdges.filter(edge => edge.childTag === 'token')).toHaveLength(2)
    expect(repeated.bindingEdges.every(edge => edge.status.kind === 'gap')).toBe(true)

    // Independent topology oracle: the authored graph above has two grammar ->
    // token edges in distinct contexts, while the repeated graph has two fixed
    // parent slots feeding one recognition state. Parser/language dedup alone
    // makes one of these assertions fail; edge dedup alone makes the other fail.
  })

  it('inventories the final named winner instead of a stale lazy thunk', () => {
    const stale = ref<string>()
    stale.define(literal('a'))
    Object.defineProperty(stale, '_ruleName', { value: 'Word' })
    const winner = literal('b')
    const wrapped = token(stale)
    const resolve = (name: string): Combinator<unknown> | undefined => name === 'Word' ? winner : undefined

    const direct = collectLexicalAlphabet([stale], resolve)
    expect(direct.capabilities.map(site => site.semanticKey)).toEqual(['L\u0000b\u0000'])
    const atomic = collectLexicalAlphabet([wrapped], resolve)
    expect(atomic.recognizers[0]!.ir).toMatchObject({ kind: 'literal', value: 'b' })

    // RED provenance: thunk-first resolution inventories `a` in both places,
    // even though final compose resolution selected `b`.
    expect(direct.capabilities).not.toContainEqual(expect.objectContaining({ semanticKey: 'L\u0000a\u0000' }))
  })

  it('matches an explicit final-winner oracle after compose replaces a rule', () => {
    const base = rules(g => ({
      Entry: sequence(g.Word, literal('!')),
      Word: literal('a'),
    }))
    const delta = rules(() => ({ Word: literal('b') }))
    const composed = compose([base, delta]) as unknown as Record<string, unknown>
    const winners = composedCoverageRules(composed)
    expect(winners).toBeDefined()
    const names = Object.keys(winners!).sort()
    const namedRoots = names.map(name => [name, winners![name]!] as const)
    const alphabet = collectLexicalAlphabet(namedRoots.map(([, parser]) => parser), name => winners![name])
    const oracle = independentCapabilityOracle(namedRoots, name => winners![name])
    expect(alphabet.capabilities).toHaveLength(oracle.rows.length)
    for (const expected of oracle.rows) {
      expect(alphabet.capabilities.some(actual =>
        actual.atom === expected.atom
        && actual.parser === expected.parser
        && sameOracleContext(expected.context, {
          trivia: actual.context.trivia,
          scanSkip: actual.context.scanSkip,
          trackLines: actual.context.trackLines,
          captureTrivia: actual.context.captureTrivia,
          rootCapture: actual.context.opaqueRootCapture,
          dynamicState: actual.context.dynamicState,
        }))).toBe(true)
    }

    // Independent post-compose oracle: the public composed parser accepts the
    // replacement spelling and rejects the superseded one. The capability graph
    // must contain that same final winner, regardless of its own walk order.
    expect(run(composed.Entry as never, 'b!').ok).toBe(true)
    expect(run(composed.Entry as never, 'a!').ok).toBe(false)
    const terminalKeys = new Set(alphabet.capabilities
      .filter(site => site.atom === 'terminal')
      .map(site => site.semanticKey))
    expect(terminalKeys).toContain('L\u0000b\u0000')
    expect(terminalKeys).not.toContain('L\u0000a\u0000')

    const isFinalWord = (row: { parser: Combinator<unknown>; atom: string; path: string }): boolean =>
      row.atom === 'terminal'
      && row.parser._def.tag === 'literal'
      && row.parser._def.value === 'b'
    expect(oracle.rows.some(row => row.path.startsWith('rule:Entry/') && isFinalWord(row))).toBe(true)
    const planted = independentCapabilityOracle(namedRoots, name => winners![name], 'Word')
    expect(planted.rows.some(row => row.path.startsWith('rule:Entry/') && isFinalWord(row))).toBe(false)

    // RED provenance: a thunk-first or pre-compose walk reports the overridden
    // `a` body even while the independently executed composed grammar parses `b`;
    // the explicit omit-winner plant removes Entry's `b` occurrence and turns
    // the independent assertion above RED.
  })

  it('follows a tracked final rule wrapper through to its recursive reference body', () => {
    const grammar = rules({ trackLines: true }, g => ({
      Nest: choice(sequence(literal('('), g.Nest, literal(')')), literal('x')),
    }))
    const alphabet = collectLexicalAlphabet([grammar.Nest], name => name === 'Nest' ? grammar.Nest : undefined)
    expect(alphabet.capabilities.map(site => site.atom)).toEqual([
      'choice', 'terminal', 'terminal', 'terminal',
    ])
    expect(alphabet.capabilities.map(site => site.semanticKey)).toEqual([
      'C\u00002\u0000firstMatch',
      'L\u0000(\u0000',
      'L\u0000)\u0000',
      'L\u0000x\u0000',
    ])

    // RED provenance: winner!==reference alone treats the rules()-installed
    // tracking scope as an override, resolves back to the in-flight reference,
    // and drops this entire recursive grammar from the census.
  })

  it('recognizes an unbounded final-wrapper chain that bottoms out at the same reference', () => {
    const grammar = rules(g => ({
      Nest: choice(sequence(literal('('), g.Nest, literal(')')), literal('x')),
    }))
    const pending: Combinator<unknown>[] = [grammar.Nest]
    const seen = new Set<Combinator<unknown>>()
    let reference: Combinator<unknown> | undefined
    while (pending.length > 0 && reference === undefined) {
      const current = pending.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      if (current._def.tag === 'lazy'
        && (current as Combinator<unknown> & { _ruleName?: string })._ruleName === 'Nest') {
        reference = current
      } else pending.push(...rawDefEdges(current).map(edge => edge.parser))
    }
    expect(reference).toBeDefined()
    let winner: Combinator<unknown> = reference!
    for (let i = 0; i < 33; i++) winner = parser({ trackLines: true }, winner)
    expect(winnerWrapsReference(winner, reference!)).toBe(true)

    // RED provenance: the previous depth-16 cutoff returned false here and let
    // final-winner resolution substitute a wrapper around the same reference as
    // if it were an overriding rule body.
  })

  it('uses the authoritative balanced constructor language instead of its eager recursive body', () => {
    const group = balanced('(', ')', { skip: [regex(/"(?:\\.|[^"\\])*"/)] })
    const alphabet = collectLexicalAlphabet([group])
    expect(alphabet.sites).toHaveLength(1)
    expect(alphabet.sites[0]).not.toHaveProperty('refusal')
    expect(alphabet.recognizers[0]!.ir).toMatchObject({
      kind: 'balanced', open: '(', close: ')', strict: false, raw: false,
      skip: [{ kind: 'regex', source: '"(?:\\\\.|[^"\\\\])*"' }],
    })
    expect(alphabet.capabilities[0]!.obligations.recognition).toEqual({ kind: 'complete' })
    expect(collectLexicalAlphabet([token(group)]).recognizers[0]!.ir)
      .toMatchObject({ kind: 'balanced', open: '(', close: ')' })

    // RED provenance: deleting the `_balancedSpec` path exposes the eager
    // transform/recursive body and changes recognition back to GAP.
    const unmarked = {
      _tag: group._tag, _meta: group._meta, _def: group._def,
      parse: group.parse.bind(group),
    } as Combinator<string>
    expect(collectLexicalAlphabet([unmarked]).capabilities[0]!.obligations.recognition)
      .toMatchObject({ kind: 'gap', reason: expect.stringContaining('transform is effectful') })
  })

  it('folds ambient scanSkip before a non-raw balanced own skip and excludes it for raw', () => {
    const ambient = regex(/"(?:\\.|[^"\\])*"/)
    const own = regex(/'(?:\\.|[^'\\])*'/)
    const scoped = rules({ scanSkip: [ambient] }, () => ({
      Group: balanced('(', ')', { skip: [own] }),
      RawGroup: balanced('(', ')', { skip: [own], raw: true }),
    }))
    const alphabet = collectLexicalAlphabet([scoped.Group, scoped.RawGroup])
    const language = (parser: Combinator<unknown>) => {
      const site = alphabet.capabilities.find(entry => entry.parser === parser)!
      return JSON.parse(site.semanticKey.slice(2)) as { skip: Array<{ source: string }> }
    }
    expect(language(scoped.Group).skip.map(entry => entry.source)).toEqual([
      '"(?:\\\\.|[^"\\\\])*"',
      "'(?:\\\\.|[^'\\\\])*'",
    ])
    expect(language(scoped.RawGroup).skip.map(entry => entry.source)).toEqual([
      "'(?:\\\\.|[^'\\\\])*'",
    ])

    // RED provenance: omitting the occurrence context makes both non-raw
    // grammars share the own-skip-only language; folding ambient into raw makes
    // RawGroup context-dependent contrary to balanced({ raw:true }).
  })

  it('elides only a trivia scope whose direct token child shadows its lexical context', () => {
    const whitespace = regex(/ +/)
    const shadowed = token(sequence(
      literal(':'),
      not(parser({ trivia: whitespace }, token(sequence(literal('extend'), literal('('))))),
      regex(/[a-z]+/),
    ))
    const alphabet = collectLexicalAlphabet([shadowed])
    expect(alphabet.capabilities[0]!.obligations.recognition).toEqual({ kind: 'complete' })
    expect(alphabet.recognizers[0]!.ir).toMatchObject({
      kind: 'sequence',
      parts: [
        { kind: 'literal', value: ':' },
        { kind: 'assert', positive: false, body: { kind: 'sequence' } },
        { kind: 'regex', source: '[a-z]+' },
      ],
    })

    const contextBearing = token(sequence(
      literal(':'),
      not(parser({ trivia: whitespace }, sequence(literal('extend'), literal('(')))),
      regex(/[a-z]+/),
    ))
    expect(collectLexicalAlphabet([contextBearing]).capabilities[0]!.obligations.recognition)
      .toMatchObject({ kind: 'gap', reason: expect.stringContaining('trivia-bearing scope') })

    // RED provenance: stripping every grammar wrapper makes the second token
    // COMPLETE even though its scoped trivia changes the child sequence's
    // language; refusing every scoped wrapper leaves the first token GAP even
    // though the direct token child clears that context before recognition.
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
    expect(alphabet.capabilities[0]).toMatchObject({
      status: { kind: 'impossible', proof: expect.stringContaining('positive width') },
      obligations: {
        recognition: { kind: 'impossible', proof: expect.stringContaining('positive width') },
        diagnosticsAndEffects: { kind: 'gap' },
      },
    })
  })
})
