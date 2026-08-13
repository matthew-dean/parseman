import { describe, expect, it } from 'vitest'
import {
  assertLexicalCapabilityClosure, collectAlphabet, collectLexicalAlphabet,
  collectLexicalCapabilities, compatibleLexicalOutcomes, selectedLexicalOutcome, winnerWrapsReference,
  type LexicalTokenClassifier,
} from '../../src/compiler/token-alphabet.ts'
import type { Combinator, ParseContext, ParseError, ParserDef } from '../../src/types.ts'
import { composedCoverageRules } from '../../src/compiler/linker.ts'
import { encodeTable } from '../../src/table/encode.ts'
import {
  adjacent, attempt, balanced, choice, compose, dispatch, endsWith, expect as expectCombinator, field, gate, label, leaf,
  keywords, literal, makeWhen, many, matches, node, not, otherwise, optional, parse, parser, peek, ref, regex, routed, rules, scanTo,
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
        status: 'complete',
      },
    ])
    expect(alphabet.capabilities).not.toContainEqual(expect.objectContaining({ parser: privateSuffix }))
    expect(alphabet.capabilities[2]!.obligations).toEqual({
      recognition: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      diagnostics: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      boundaryPlan: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      materializationPlan: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      supportedVariants: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      bindingAndReachability: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
    })
    expect(alphabet.capabilities[0]!.obligations).toMatchObject({
      recognition: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      diagnostics: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      boundaryPlan: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      materializationPlan: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      supportedVariants: { representation: { kind: 'complete' }, executableLowering: { kind: 'complete' } },
      bindingAndReachability: { representation: { kind: 'gap' }, executableLowering: { kind: 'gap' } },
    })
    expect(alphabet.capabilities[0]!.obligations.bindingAndReachability.executableLowering)
      .toMatchObject({ kind: 'gap', reason: expect.stringContaining('fixed-tuple') })
    expect(alphabet.capabilityComplete).toBe(false)
    // Whole-program closure is the serialization gate. The complete TOKEN
    // occurrence must not leak into this otherwise incomplete CHARACTER table.
    expect(encodeTable({ Root: root }).lex).toBeUndefined()
  })

  it('admits exactly one complete selected token body and rejects astral suffix lookalikes', () => {
    const selected = token(sequence(regex(/[a-z]+/), optional(literal('('))))
    const capability = collectLexicalCapabilities([selected])
    expect(capability.capabilityComplete).toBe(true)
    expect(capability.capabilities).toEqual([
      expect.objectContaining({ atom: 'token', status: { kind: 'complete' } }),
    ])
    expect(capability.bindingEdges.every(edge => edge.status.kind === 'complete')).toBe(true)

    const astral = token(sequence(regex(/[a-z]+/), optional(literal('🙂'))))
    expect(collectLexicalCapabilities([astral]).capabilityComplete).toBe(false)
    const astralProg = encodeTable({ Root: astral })
    expect(astralProg.lex).toBeUndefined()

    const newline = token(sequence(regex(/[a-z]+/), optional(literal('\n'))))
    expect(collectLexicalCapabilities([newline]).capabilityComplete).toBe(false)
    expect(encodeTable({ Root: newline }, { trackLines: true }).lex).toBeUndefined()
  })

  it('fails the final-graph census when a valid candidate is hidden', () => {
    const root = sequence(literal('!'), token(regex(/[a-z]+/)))
    const alphabet = collectLexicalAlphabet([root])
    expect(() => assertLexicalCapabilityClosure([root], {
      capabilities: alphabet.capabilities.slice(1),
      capabilityLanguages: alphabet.capabilityLanguages,
      bindingEdges: alphabet.bindingEdges,
      decisionFamilies: alphabet.decisionFamilies,
      decisionOutcomes: alphabet.decisionOutcomes,
      decisions: alphabet.decisions,
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
        bindingAndReachability: {
          representation: { kind: 'complete' }, executableLowering: { kind: 'complete' },
        } as const,
      },
    } : site)
    expect(() => assertLexicalCapabilityClosure([root], {
      capabilities: changed,
      capabilityLanguages: alphabet.capabilityLanguages,
      bindingEdges: alphabet.bindingEdges,
      decisionFamilies: alphabet.decisionFamilies,
      decisionOutcomes: alphabet.decisionOutcomes,
      decisions: alphabet.decisions,
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
    expect(alphabet.capabilities[0]!.obligations.recognition.representation).toEqual({ kind: 'complete' })
    expect(collectLexicalAlphabet([token(group)]).recognizers[0]!.ir)
      .toMatchObject({ kind: 'balanced', open: '(', close: ')' })

    // RED provenance: deleting the `_balancedSpec` path exposes the eager
    // transform/recursive body and changes recognition back to GAP.
    const unmarked = {
      _tag: group._tag, _meta: group._meta, _def: group._def,
      parse: group.parse.bind(group),
    } as Combinator<string>
    expect(collectLexicalAlphabet([unmarked]).capabilities[0]!.obligations.recognition.representation)
      .toMatchObject({ kind: 'gap', reason: expect.stringContaining('transform is effectful') })
  })

  it('keeps ambient balanced scanSkip out of direct lexical IR for raw and non-raw sites', () => {
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
      "'(?:\\\\.|[^'\\\\])*'",
    ])
    expect(language(scoped.RawGroup).skip.map(entry => entry.source)).toEqual([
      "'(?:\\\\.|[^'\\\\])*'",
    ])

    expect(alphabet.scanConsumerPolicies.map(policy => policy.ambient)).toEqual([
      'array-identity-interior-cache', 'none-raw',
    ])
    // RED provenance: folding ambient into canonical IR direct-binds a public
    // callback and loses balanced's array-identity cache and dynamic `.parse`.
  })

  it('records scanTo and balanced as distinct scan policies and direct-binds only ownSkip', () => {
    const ambientA = literal('ambient-a')
    const ambientB = literal('ambient-b')
    const ownA = literal('own-a')
    const ownB = literal('own-b')
    const scan = token(scanTo(literal(';'), { skip: [ownA, ownB] }))
    const group = balanced('(', ')', { skip: [ownA] })
    const scoped = rules({ scanSkip: [ambientA, ambientB] }, () => ({ Scan: scan, Group: group }))
    const roots = [scoped.Scan, scoped.Group]
    const alphabet = collectLexicalAlphabet(roots)

    expect(alphabet.scanConsumerPolicies.map(policy => policy.kind)).toEqual(['scanTo', 'balanced'])
    expect(alphabet.scanConsumerPolicies.every(policy => policy.pendingReuse === 'forbidden')).toBe(true)
    expect(alphabet.scanConsumerPolicies.map(policy => policy.ambient)).toEqual([
      'enumerate-trivia-then-scanSkip-per-parse-attempt',
      'array-identity-interior-cache',
    ])
    expect(alphabet.scanConsumerPolicies.map(policy => policy.lookup)).toEqual([
      'dynamic-parse-property-every-skip-test',
      'dynamic-parse-property-every-skip-test',
    ])
    const plans = alphabet.scanConsumerPolicies.map(policy =>
      policy.ownSkipPlanId === undefined ? undefined : alphabet.ownSkipPlans[policy.ownSkipPlanId])
    expect(plans.map(plan => plan?.entries.map(entry => entry.semanticKey))).toEqual([
      [
        JSON.stringify({ kind: 'literal', value: 'own-a', caseInsensitive: false }),
        JSON.stringify({ kind: 'literal', value: 'own-b', caseInsensitive: false }),
      ],
      [JSON.stringify({ kind: 'literal', value: 'own-a', caseInsensitive: false })],
    ])
    expect(JSON.stringify(alphabet.ownSkipPlans)).not.toContain('ambient-a')
    expect(JSON.stringify(alphabet.ownSkipPlans)).not.toContain('ambient-b')
    expect(alphabet.scanConsumerPolicies[0]).toMatchObject({
      context: 'detached-per-attempt-state-errors-only',
    })
    expect(alphabet.scanConsumerPolicies[1]).toMatchObject({
      context: 'token-cleared-original', cache: 'lookup-every-attempt-enumerate-on-miss',
    })

    expect(() => assertLexicalCapabilityClosure(roots, alphabet)).not.toThrow()
    expect(() => assertLexicalCapabilityClosure(roots, {
      ...alphabet, scanConsumerPolicies: alphabet.scanConsumerPolicies.slice(1),
    })).toThrow('lexical capability census is incomplete')
    expect(() => assertLexicalCapabilityClosure(roots, {
      ...alphabet,
      contextSnapshots: alphabet.contextSnapshots.map((snapshot, index) => index === 0
        ? { ...snapshot, hasScanSkip: !snapshot.hasScanSkip }
        : snapshot),
    })).toThrow('lexical capability census is incomplete')
    expect(() => assertLexicalCapabilityClosure(roots, {
      ...alphabet,
      ownSkipPlans: alphabet.ownSkipPlans.map((plan, index) => index === 0
        ? { ...plan, entries: plan.entries.slice(1) }
        : plan),
    })).toThrow('lexical capability census is incomplete')

    // RED provenance: folding candidate.context.scanSkip into balanced IR puts
    // ambient-a/ambient-b into a direct lexical plan. A universal snapshot also
    // collapses the two distinct enumeration/context/cache policies. Omitting a
    // policy, static context, or authored own-skip row makes closure fail above.
  })

  it('records live ambient lookup without reading it or binding raw scanTo skip', () => {
    const target = literal('ambient')
    let parseReads = 0
    const hostile = new Proxy(target, {
      get(value, key, receiver) {
        if (key === 'parse') {
          parseReads++
          throw new Error('live parse getter must remain a runtime operation')
        }
        return Reflect.get(value, key, receiver)
      },
    })
    const own = literal('own')
    const scoped = rules({ scanSkip: [hostile] }, () => ({
      Normal: token(scanTo(literal(';'), { skip: [own] })),
      Raw: token(scanTo(literal(';'), { skip: [own], raw: true })),
    }))
    const alphabet = collectLexicalAlphabet([scoped.Normal, scoped.Raw])
    expect(parseReads).toBe(0)
    expect(alphabet.scanConsumerPolicies.map(policy => policy.ambient)).toEqual([
      'enumerate-trivia-then-scanSkip-per-parse-attempt', 'none-raw',
    ])
    expect(alphabet.scanConsumerPolicies.map(policy => policy.ownSkipPlanId)).toEqual([0, undefined])
    expect(alphabet.ownSkipPlans).toHaveLength(1)
    // RED provenance: reading or direct-binding an ambient callback touches the
    // throwing `.parse` getter during compilation. Treating scanTo(raw) like
    // balanced(raw) incorrectly retains its authored skipper.
  })

  it('keeps nested token scanners owned and snapshots their post-token context', () => {
    const trivia = regex(/\s+/)
    const nestedToken = token(token(scanTo(literal(';'))))
    const nestedChoice = token(choice(scanTo(literal(';')), literal('x')))
    const scoped = rules({ trivia }, () => ({ NestedToken: nestedToken, NestedChoice: nestedChoice }))
    const alphabet = collectLexicalAlphabet([scoped.NestedToken, scoped.NestedChoice])
    expect(alphabet.scanConsumerPolicies).toHaveLength(2)
    expect(alphabet.capabilities).toHaveLength(2)
    for (const site of alphabet.capabilities) {
      expect(site.scanConsumerPolicyIds).toHaveLength(1)
      const policy = alphabet.scanConsumerPolicies[site.scanConsumerPolicyIds[0]!]!
      expect(policy.siteId).toBe(site.id)
      expect(alphabet.contextSnapshots[site.contextSnapshotId]).toMatchObject({ hasTrivia: true })
      expect(alphabet.contextSnapshots[policy.contextSnapshotId]).toMatchObject({ hasTrivia: false })
      expect(policy.contextSnapshotId).not.toBe(site.contextSnapshotId)
    }
    // RED provenance: treating every nested token/choice as a separate boundary
    // omits both policies because private token children are not capability
    // occurrences. Keying the policy with the site's outer snapshot leaves
    // hasTrivia=true even though token entered and cleared it first.
  })

  it('preserves observable captureTrivia while token suppresses collector sinks', () => {
    const base = literal('x')
    let observedCapture: boolean | undefined
    let observedLeaves: unknown
    const hostile: Combinator<unknown> = {
      ...base,
      parse(input, pos, ctx) {
        observedCapture = ctx.captureTrivia
        observedLeaves = ctx._cstLeaves
        return base.parse(input, pos, ctx)
      },
    }
    const group = token(balanced('(', ')', { skip: [hostile] }))
    const scoped = parser({ captureTrivia: true }, group)
    const alphabet = collectLexicalAlphabet([scoped])
    const policy = alphabet.scanConsumerPolicies[0]!
    expect(policy.kind).toBe('balanced')
    expect(alphabet.contextSnapshots[policy.contextSnapshotId]).toMatchObject({
      hasTrivia: false, captureTrivia: true,
    })
    const result = scoped.parse('(x)')
    expect(result.ok).toBe(true)
    expect(observedCapture).toBe(true)
    expect(observedLeaves).toBeUndefined()
    // RED provenance: clearing captureTrivia in token context transfer makes the
    // policy disagree with the hostile own-skip callback. The collector remains
    // suppressed by its separate sink transaction, not by changing the flag.
  })

  it('keeps scan arms unrestricted without erasing sibling token families', () => {
    const shared = choice(
      balanced('(', ')', { skip: [literal('"')] }),
      token(scanTo(literal(';'), { skip: [literal("'")] })),
      literal('x'),
    )
    const alphabet = collectLexicalAlphabet([shared])
    const decision = alphabet.decisions.find(site =>
      alphabet.capabilities[site.siteId]!.parser === shared)!
    expect(decision.pendingReuse).toBe('forbidden')
    expect(decision.families).toHaveLength(2)
    expect(decision.families.every(family =>
      family.arms[1]!.acceptance.kind === 'unrestricted')).toBe(true)
    expect(decision.families.some(family =>
      family.arms[0]!.acceptance.kind === 'outcomes')).toBe(true)
    expect(decision.families.some(family =>
      family.arms[2]!.acceptance.kind === 'outcomes')).toBe(true)
    expect(decision.precisionNotes).toContainEqual(expect.stringContaining('dynamic scan consumer'))
    expect(decision.reuseEpochs).toEqual([
      { armIds: [0], pendingReuse: 'forbidden', boundary: 'dynamic-scan' },
      { armIds: [1], pendingReuse: 'forbidden', boundary: 'dynamic-scan' },
      { armIds: [2], pendingReuse: 'unproved', boundary: 'none' },
    ])

    const planted = alphabet.decisions.map(site => site === decision
      ? { ...site, pendingReuse: 'unproved' as const }
      : site)
    expect(() => assertLexicalCapabilityClosure([shared], {
      ...alphabet,
      decisions: planted,
    })).toThrow('lexical capability census is incomplete')
    const crossedBoundary = alphabet.decisions.map(site => site === decision
      ? {
          ...site,
          reuseEpochs: [{
            armIds: [0, 1, 2], pendingReuse: 'unproved' as const, boundary: 'none' as const,
          }],
        }
      : site)
    expect(() => assertLexicalCapabilityClosure([shared], {
      ...alphabet,
      decisions: crossedBoundary,
    })).toThrow('lexical capability census is incomplete')
    // RED provenance: allowing a pending range across the unrestricted scan
    // arm crosses observable ambient skipper callbacks. The pure balanced and
    // literal families remain available to build and price a complete body.
  })

  it('records pointer-free token-internal diagnostic events in one state session', () => {
    const fixed = token(regex(/[a-z]+\(?/))
    const min2 = token(many(keywords(['x']), { min: 2 }))
    const min1 = token(many(keywords(['x']), { min: 1 }))
    const asserted = token(sequence(not(literal('!')), peek(regex(/[a-z]/)), regex(/[a-z]+/)))
    const strict = balanced('(', ')', { strict: true, skip: [regex(/"[^"]*"/)] })
    const recovered = balanced('[', ']', { strict: false, skip: [regex(/'[^']*'/)] })
    const roots = [fixed, min2, min1, asserted, strict, recovered]
    const alphabet = collectLexicalAlphabet(roots)
    const planFor = (parser: Combinator<unknown>) => {
      const site = alphabet.capabilities.find(entry => entry.parser === parser && entry.atom === 'token')!
      expect(site.diagnosticPlanId).toBeTypeOf('number')
      return alphabet.transitionDiagnostics[site.diagnosticPlanId!]!
    }

    const fixedPlan = planFor(fixed)
    expect(fixedPlan.stateCount).toBe(4)
    expect(fixedPlan.events).toEqual([{ op: 'FAIL', state: 1, expectedId: 0 }])
    expect(fixedPlan.expected).toEqual([['/[a-z]+\\(?/']])

    const required = planFor(min2)
    expect(required.events.filter(event => event.op === 'REQUIRE')).toEqual([
      expect.objectContaining({ op: 'REQUIRE', state: 0, childStart: 1, childEnd: 2 }),
    ])
    expect(required.expected).toContainEqual(['keyword'])
    expect(required.expected).toContainEqual(['"x"'])
    expect(planFor(min1).events.some(event => event.op === 'REQUIRE')).toBe(false)
    const sourceRequired = min2.parse('x', 0, {} as never)
    expect(sourceRequired).toMatchObject({ ok: false, span: { start: 1 }, expected: ['"x"'] })

    const assertionEvents = planFor(asserted).events.filter(event => event.op === 'ASSERT')
    expect(assertionEvents).toEqual([
      expect.objectContaining({
        positive: false, snapshotPolicy: 'saveLookaheadMark', execution: 'deferred',
      }),
      expect.objectContaining({
        positive: true, snapshotPolicy: 'saveLookaheadMark', execution: 'deferred',
      }),
    ])
    expect(assertionEvents.every(event => event.innerStart < event.innerEnd)).toBe(true)

    const strictPlan = planFor(strict)
    const recoverPlan = planFor(recovered)
    expect(strictPlan.events).toContainEqual(expect.objectContaining({
      op: 'BAL_CLOSE_STRICT', probe: true, committed: false,
      when: 'close-miss-after-open-body-success',
    }))
    expect(recoverPlan.events).toContainEqual(expect.objectContaining({
      op: 'BAL_CLOSE_RECOVER', probe: true, committed: false, result: 'parseError',
      when: 'close-miss-after-open-body-success',
      errorSpan: 'close-position', lineAnnotation: 'when-active',
      errorSink: 'when-active', cstErrorCapture: 'when-active',
    }))
    expect(strictPlan.events.filter(event => event.op === 'FAIL')).toHaveLength(2) // open + skipper
    expect(recoverPlan.events.filter(event => event.op === 'FAIL')).toHaveLength(2)
    const strictClose = strictPlan.events.find(event => event.op === 'BAL_CLOSE_STRICT')!
    const recoverClose = recoverPlan.events.find(event => event.op === 'BAL_CLOSE_RECOVER')!
    const strictResult = strict.parse('(x', 0, { trackLines: false, state: {} })
    expect(strictResult).toMatchObject({ ok: false, expected: strictPlan.expected[strictClose.expectedId] })
    if (!strictResult.ok) expect(strictResult.committed).not.toBe(true)
    const errors: ParseError[] = []
    const recoveredResult = recovered.parse('[x', 0, {
      trackLines: false, state: {}, _errors: errors,
    })
    expect(recoveredResult.ok).toBe(true)
    expect(errors).toEqual([expect.objectContaining({ expected: recoverPlan.expected[recoverClose.expectedId] })])

    const pointerFree = (value: unknown): boolean => {
      if (typeof value === 'function') return false
      if (value === null || typeof value !== 'object') return true
      if (value instanceof Map || value instanceof Set) return false
      return Object.values(value).every(pointerFree)
    }
    expect(alphabet.transitionDiagnostics.every(pointerFree)).toBe(true)
    expect(alphabet.transitionDiagnostics.every(plan => plan.events.every(event =>
      event.state >= 0 && event.state < plan.stateCount))).toBe(true)
    expect(alphabet.capabilities.filter(site => site.atom === 'token').every(site =>
      site.obligations.diagnostics.executableLowering.kind === 'gap')).toBe(true)
    expect(encodeTable(Object.fromEntries(roots.map((root, index) => [`R${index}`, root]))))
      .not.toHaveProperty('transitionDiagnostics')

    const sameA = token(sequence(literal('q'), optional(literal('!'))))
    const sameB = token(sequence(literal('q'), optional(literal('!'))))
    const sharedPlans = collectLexicalAlphabet([sameA, sameB])
    const occurrenceIds = sharedPlans.capabilities
      .filter(site => site.atom === 'token').map(site => site.diagnosticPlanId)
    expect(occurrenceIds).toEqual([0, 0])
    expect(sharedPlans.transitionDiagnostics).toHaveLength(1)

    const planted = alphabet.transitionDiagnostics.map((plan, index) => index === fixedPlan.id
      ? { ...plan, events: plan.events.slice(1) }
      : plan)
    expect(() => assertLexicalCapabilityClosure(roots, {
      ...alphabet, transitionDiagnostics: planted,
    })).toThrow('lexical capability census is incomplete')
    for (const op of ['FAIL', 'ASSERT', 'REQUIRE', 'BAL_CLOSE_STRICT', 'BAL_CLOSE_RECOVER'] as const) {
      const owner = alphabet.transitionDiagnostics.find(plan => plan.events.some(event => event.op === op))!
      const omitted = alphabet.transitionDiagnostics.map(plan => plan !== owner ? plan : ({
        ...plan, events: plan.events.filter(event => event.op !== op),
      }))
      expect(() => assertLexicalCapabilityClosure(roots, {
        ...alphabet, transitionDiagnostics: omitted,
      }), `omitted ${op}`).toThrow('lexical capability census is incomplete')
    }
    const skipFail = strictPlan.events.find(event => event.op === 'FAIL'
      && strictPlan.expected[event.expectedId]![0] === '/"[^"]*"/')!
    expect(skipFail).toBeDefined()
    const omittedSkip = alphabet.transitionDiagnostics.map(plan => plan !== strictPlan ? plan : ({
      ...plan, events: plan.events.filter(event => event !== skipFail),
    }))
    expect(() => assertLexicalCapabilityClosure(roots, {
      ...alphabet, transitionDiagnostics: omittedSkip,
    })).toThrow('lexical capability census is incomplete')
    // RED provenance: deleting the mandatory regex FAIL used to leave the
    // occurrence census green because internal checkpoints were not authority.
  })

  it('represents token boundaries as a well-nested overlay on the one diagnostic state session', () => {
    const simple = token(literal('a'))
    const nested = token(token(literal('b')))
    const scoped = token(parser({ trivia: null }, literal('c')))
    const hiddenBalancedWrappers = token(balanced('(', ')', {
      skip: [parser({ trivia: null }, parser({ trivia: null }, regex(/ +/)))],
    }))
    const deep = token(parser({ trivia: null }, sequence(
      literal(':'),
      not(parser({ trivia: regex(/ +/) }, token(parser({ trivia: null }, sequence(
        literal('extend'), literal('('),
      ))))),
      regex(/[a-z]+/),
    )))
    const roots = [simple, nested, scoped, hiddenBalancedWrappers, deep]
    const alphabet = collectLexicalAlphabet(roots)
    const topologyFor = (parser: Combinator<unknown>) => {
      const site = alphabet.capabilities.find(entry => entry.atom === 'token' && entry.parser === parser)!
      expect(site.boundaryTopologyId).toBeTypeOf('number')
      return alphabet.boundaryTopologies[site.boundaryTopologyId!]!
    }
    const shape = (parser: Combinator<unknown>) =>
      topologyFor(parser).frames.map(frame => frame.kind === 'token' ? 'T' : 'G').join('>')

    expect(shape(simple)).toBe('T')
    expect(shape(nested)).toBe('T>T')
    expect(shape(scoped)).toBe('T>G')
    // The balanced constructor marker hides its skipper graph from ordinary
    // ParserDef children. Only the shared normalization session sees both scopes.
    expect(shape(hiddenBalancedWrappers)).toBe('T>T>G>G')
    expect(shape(deep)).toBe('T>G>G>T>G')

    const deepSite = alphabet.capabilities.find(entry => entry.parser === deep && entry.atom === 'token')!
    const deepPlan = alphabet.transitionDiagnostics[deepSite.diagnosticPlanId!]!
    const deepControls = alphabet.controlPlans[deepSite.controlPlanId!]!
    const assertion = deepPlan.events.find(event => event.op === 'ASSERT')!
    const frames = topologyFor(deep).frames
    expect(frames.map(frame => frame.parentFrameId)).toEqual([undefined, 0, 1, 2, 3])
    expect(frames[2]).toMatchObject({
      kind: 'grammar', stateStart: assertion.innerStart, stateEnd: assertion.innerEnd,
    })
    expect(frames.slice(2).every(frame =>
      frame.stateStart >= assertion.innerStart && frame.stateEnd <= assertion.innerEnd)).toBe(true)
    for (const frame of frames) {
      const control = deepControls.controls[frame.controlId]!
      expect(control).toMatchObject({
        id: frame.controlId, kind: frame.kind,
        stateStart: frame.stateStart, stateEnd: frame.stateEnd,
      })
      expect(frame.stateStart).toBeGreaterThanOrEqual(0)
      expect(frame.stateEnd).toBeGreaterThanOrEqual(frame.stateStart)
      expect(frame.stateEnd).toBeLessThanOrEqual(deepPlan.stateCount)
      if (frame.parentFrameId !== undefined) {
        const parent = frames[frame.parentFrameId]!
        expect(frame.stateStart).toBeGreaterThanOrEqual(parent.stateStart)
        expect(frame.stateEnd).toBeLessThanOrEqual(parent.stateEnd)
      }
    }

    // Equal state intervals are not equal execution sites. Balanced skipper
    // wrappers execute conditionally and repeatedly inside the balanced VM;
    // their unique control ancestry must retain that placement rather than
    // aliasing them to the enclosing token merely because stateStart matches.
    const hiddenSite = alphabet.capabilities.find(entry =>
      entry.atom === 'token' && entry.parser === hiddenBalancedWrappers)!
    const hiddenTopology = alphabet.boundaryTopologies[hiddenSite.boundaryTopologyId!]!
    const hiddenPlan = alphabet.controlPlans[hiddenSite.controlPlanId!]!
    const hiddenGrammar = hiddenTopology.frames.find(frame => frame.kind === 'grammar')!
    const controlAncestors: string[] = []
    let control = hiddenPlan.controls[hiddenGrammar.controlId]
    while (control !== undefined) {
      controlAncestors.push(control.kind)
      control = control.parentControlId === undefined
        ? undefined : hiddenPlan.controls[control.parentControlId]
    }
    expect(controlAncestors).toEqual(['grammar', 'balanced-skip', 'balanced', 'token', 'token'])
    expect(hiddenPlan.controls.filter(entry => entry.stateStart === hiddenGrammar.stateStart)
      .map(entry => entry.id)).toEqual(expect.arrayContaining([
      hiddenGrammar.controlId,
      hiddenPlan.controls.find(entry => entry.kind === 'balanced-skip')!.id,
    ]))
    expect(hiddenGrammar.controlId)
      .not.toBe(hiddenPlan.controls.find(entry => entry.kind === 'balanced-skip')!.id)

    expect(alphabet.boundaryPlans).toEqual([{ id: 0, kind: 'token-context-transaction' }])
    expect(alphabet.materializationPlans).toEqual([{ id: 0, kind: 'token-source-range' }])
    expect(alphabet.capabilities.filter(site => site.atom === 'token').every(site =>
      site.obligations.boundaryPlan.representation.kind === 'complete'
      && site.obligations.materializationPlan.representation.kind === 'complete'
      && site.obligations.boundaryPlan.executableLowering.kind === 'gap'
      && site.obligations.materializationPlan.executableLowering.kind === 'gap')).toBe(true)
    expect(alphabet.capabilityComplete).toBe(false)

    const pointerFree = (value: unknown): boolean => {
      if (typeof value === 'function') return false
      if (value === null || typeof value !== 'object') return true
      if (value instanceof Map || value instanceof Set || isCombinator(value)) return false
      return Object.values(value).every(pointerFree)
    }
    expect(pointerFree(alphabet.boundaryPlans)).toBe(true)
    expect(pointerFree(alphabet.materializationPlans)).toBe(true)
    expect(pointerFree(alphabet.controlPlans)).toBe(true)
    expect(pointerFree(alphabet.grammarWrapperSpecs)).toBe(true)
    expect(pointerFree(alphabet.boundaryTopologies)).toBe(true)
    expect(encodeTable(Object.fromEntries(roots.map((root, index) => [`B${index}`, root]))))
      .not.toHaveProperty('boundaryTopologies')

    // Each plant mutates one independent compiler authority. Before B3 these
    // all passed because only the recognizer/diagnostic plans were closed.
    for (const planted of [
      { ...alphabet, boundaryPlans: [] },
      { ...alphabet, materializationPlans: [] },
      { ...alphabet, controlPlans: alphabet.controlPlans.slice(1) },
      { ...alphabet, grammarWrapperSpecs: alphabet.grammarWrapperSpecs.slice(1) },
      { ...alphabet, controlPlans: alphabet.controlPlans.map(plan =>
        plan !== hiddenPlan ? plan : ({
          ...plan, controls: plan.controls.filter(entry => entry.kind !== 'balanced-skip'),
        })) },
      { ...alphabet, boundaryTopologies: alphabet.boundaryTopologies.map((topology, index) =>
        index === deepSite.boundaryTopologyId ? { ...topology, frames: topology.frames.slice(0, -1) } : topology) },
      { ...alphabet, capabilities: alphabet.capabilities.map(site => site === deepSite
        ? { ...site, boundaryTopologyId: topologyFor(simple).id } : site) },
    ]) {
      expect(() => assertLexicalCapabilityClosure(roots, planted))
        .toThrow('lexical capability census is incomplete')
    }
    // RED provenance: replacing frame.controlId with stateStart or omitting the
    // balanced-skip control used to preserve every interval/count while losing
    // the conditional/repeated execution anchor.
  })

  it('preserves authored grammar-wrapper policy separately from effective context', () => {
    const inheritedGrammar = parser({ trivia: null }, token(literal('x')))
    const disabledGrammar = parser({ trivia: null, trackLines: false }, token(literal('x')))
    const authoredCaptureKinds = ['comment', 'license']
    const capturedKindsGrammar = parser({
      captureTriviaKinds: authoredCaptureKinds,
    }, token(literal('x')))
    const inherited = token(inheritedGrammar)
    const disabled = token(disabledGrammar)
    const capturedKinds = token(capturedKindsGrammar)
    const alphabet = collectLexicalAlphabet([inherited, disabled, capturedKinds])
    authoredCaptureKinds.push('mutated-after-inventory')
    const grammarSpecFor = (owner: Combinator<unknown>) => {
      const site = alphabet.capabilities.find(entry => entry.atom === 'token' && entry.parser === owner)!
      const topology = alphabet.boundaryTopologies[site.boundaryTopologyId!]!
      const grammarFrame = topology.frames.find(frame => frame.kind === 'grammar')!
      return alphabet.grammarWrapperSpecs[grammarFrame.wrapperSpecId]!
    }
    const inheritedSpec = grammarSpecFor(inherited)
    const disabledSpec = grammarSpecFor(disabled)
    const capturedSpec = grammarSpecFor(capturedKinds)
    expect(inheritedSpec.trackLines).toBe('inherit')
    expect(disabledSpec.trackLines).toBe('off')
    expect(inheritedSpec.id).not.toBe(disabledSpec.id)
    expect(capturedSpec.captureTriviaKindsId).toBeTypeOf('number')
    expect(alphabet.grammarCaptureTriviaKinds[capturedSpec.captureTriviaKindsId!])
      .toEqual(['comment', 'license'])
    expect(capturedKindsGrammar._def.tag === 'grammar'
      ? capturedKindsGrammar._def.constructionCaptureTriviaKinds : undefined)
      .toEqual(['comment', 'license', 'mutated-after-inventory'])
    expect(capturedKindsGrammar.parse.toString()).not.toContain('constructionTrackLines')
    expect(capturedKindsGrammar.parse.toString()).not.toContain('constructionCaptureTriviaKinds')

    // Construction policy is ordinary typed compiler IR, not an identity cache
    // or hidden property. A final-winner/compose-style ParserDef copy retains it
    // deterministically without consulting the executable parser closure.
    if (capturedKindsGrammar._def.tag !== 'grammar') throw new Error('lost grammar')
    const copiedGrammar = synthetic(capturedKindsGrammar, { ...capturedKindsGrammar._def })
    const copied = collectLexicalAlphabet([token(copiedGrammar)])
    expect(copied.capabilities.find(site => site.atom === 'token')!
      .obligations.boundaryPlan.representation).toEqual({ kind: 'complete' })
    expect(copied.grammarCaptureTriviaKinds).toEqual([
      ['comment', 'license', 'mutated-after-inventory'],
    ])

    const observed = (root: Combinator<unknown>): { result: unknown; trackReads: number } => {
      let trackReads = 0
      const target = { trackLines: false, state: {} } as ParseContext
      const ctx = new Proxy(target, {
        get(value, key, receiver) {
          if (key === 'trackLines') trackReads++
          return Reflect.get(value, key, receiver)
        },
      })
      return { result: root.parse('x', 0, ctx), trackReads }
    }
    const inheritRun = observed(inherited)
    const disabledRun = observed(disabled)
    expect(inheritRun.result).toEqual(disabledRun.result)
    // Both wrappers spread the incoming context; only the inherited resolver
    // performs one additional pre-clone read.
    expect(inheritRun.trackReads).toBe(disabledRun.trackReads + 1)

    // Hand-built/old grammar defs lack exact construction policy. Recognition
    // remains represented, but boundary/materialization representation declines
    // without allocating a false wrapper spec or topology.
    const originalDef = inheritedGrammar._def
    if (originalDef.tag !== 'grammar') throw new Error('lost grammar')
    const {
      constructionTrackLines: _constructionTrackLines,
      constructionCaptureTriviaKinds: _constructionCaptureTriviaKinds,
      ...oldDef
    } = originalDef
    const oldGrammar = synthetic(inheritedGrammar, oldDef)
    const oldOwner = token(oldGrammar)
    const declined = collectLexicalAlphabet([oldOwner])
    const oldSite = declined.capabilities.find(site => site.atom === 'token')!
    expect(oldSite.obligations.recognition.representation).toEqual({ kind: 'complete' })
    expect(oldSite.obligations.diagnostics.representation).toEqual({ kind: 'complete' })
    expect(oldSite.obligations.boundaryPlan.representation).toMatchObject({ kind: 'gap' })
    expect(oldSite).not.toHaveProperty('boundaryTopologyId')
    expect(declined.grammarWrapperSpecs).toEqual([])
    expect(declined.boundaryTopologies).toEqual([])

    // A missing late wrapper refuses the whole occurrence before an earlier
    // valid wrapper can intern unreachable source-operation metadata.
    const lateDecline = collectLexicalAlphabet([token(sequence(
      parser({ trivia: null }, literal('a')),
      oldGrammar,
    ))])
    expect(lateDecline.grammarWrapperSpecs).toEqual([])
    expect(lateDecline.boundaryTopologies).toEqual([])

    // Construction metadata must not add option reads or iteration. With
    // trivia:null the source path ignores captureTriviaKinds entirely, so a
    // hostile getter remains untouched. With inherited trivia the source reads
    // the policy once but does not iterate it until parsing; capability
    // inventory snapshots fail closed without leaving partial wrapper metadata.
    let ignoredCaptureReads = 0
    const ignoredOptions = new Proxy({ trivia: null }, {
      get(target, key, receiver) {
        if (key === 'captureTriviaKinds') {
          ignoredCaptureReads++
          throw new Error('ignored capture policy was read')
        }
        return Reflect.get(target, key, receiver)
      },
    })
    expect(() => parser(ignoredOptions, token(literal('i')))).not.toThrow()
    expect(ignoredCaptureReads).toBe(0)

    let activeCaptureReads = 0
    const hostileKinds = new Proxy(['comment'], {
      get(target, key, receiver) {
        if (key === Symbol.iterator) throw new Error('hostile capture policy iteration')
        return Reflect.get(target, key, receiver)
      },
    })
    const activeOptions = new Proxy({ captureTriviaKinds: hostileKinds }, {
      get(target, key, receiver) {
        if (key === 'captureTriviaKinds') activeCaptureReads++
        return Reflect.get(target, key, receiver)
      },
    })
    const hostileGrammar = parser(activeOptions, token(literal('h')))
    expect(activeCaptureReads).toBe(1)
    const hostile = collectLexicalAlphabet([token(hostileGrammar)])
    expect(activeCaptureReads).toBe(1)
    expect(hostile.capabilities.find(site => site.atom === 'token')!
      .obligations.boundaryPlan.representation)
      .toMatchObject({ kind: 'gap', reason: expect.stringContaining('snapshotted safely') })
    expect(hostile.grammarWrapperSpecs).toEqual([])
    expect(hostile.boundaryTopologies).toEqual([])
  })

  it('pins the source token transaction order and its abrupt-completion boundaries', () => {
    const slots = [
      'trivia', 'triviaKindLabels', '_cstBuf', '_cstChildren', '_cstLeaves',
      '_cstRawChildren', '_cstTriviaLog', '_triviaLog', '_rootTriviaLog',
    ] as const
    const makeTarget = (): ParseContext => ({
      trivia: literal(' '), triviaKindLabels: ['ws'], _cstBuf: undefined,
      _cstChildren: [], _cstLeaves: [], _cstRawChildren: [], _cstTriviaLog: [],
      _triviaLog: [], _rootTriviaLog: [], trackLines: false,
    })
    const run = (mode: 'fail' | 'throw', abrupt?: { phase: 'get' | 'set'; key: string; setCount?: number }) => {
      const log: string[] = []
      const target = makeTarget()
      const sets = new Map<PropertyKey, number>()
      const ctx = new Proxy(target, {
        get(value, key, receiver) {
          if ((slots as readonly PropertyKey[]).includes(key)) log.push(`get:${String(key)}`)
          if (abrupt?.phase === 'get' && abrupt.key === key) throw new Error(`abrupt get ${String(key)}`)
          return Reflect.get(value, key, receiver)
        },
        set(value, key, next, receiver) {
          if ((slots as readonly PropertyKey[]).includes(key)) log.push(`set:${String(key)}`)
          const count = (sets.get(key) ?? 0) + 1
          sets.set(key, count)
          if (abrupt?.phase === 'set' && abrupt.key === key && count === (abrupt.setCount ?? 1)) {
            throw new Error(`abrupt set ${String(key)}`)
          }
          return Reflect.set(value, key, next, receiver)
        },
      })
      const base = literal('x')
      const child: Combinator<unknown> = {
        ...base,
        parse() {
          log.push('child')
          if (mode === 'throw') throw new Error('child throw')
          return { ok: false, expected: ['x'], span: { start: 0, end: 0 } }
        },
      }
      let thrown: unknown
      try { token(child).parse('x', 0, ctx) } catch (error) { thrown = error }
      return { log, target, thrown }
    }
    const reads = slots.map(key => `get:${key}`)
    // cstCaptureActive performs its own two ordered reads after the nine saves.
    const captureReads = ['get:_cstBuf', 'get:_cstLeaves']
    const clears = slots.map(key => `set:${key}`)
    const restores = [...clears]

    const ordinary = run('fail')
    expect(ordinary.thrown).toBeUndefined()
    expect(ordinary.log).toEqual([...reads, ...captureReads, ...clears, 'child', ...restores])

    const childThrow = run('throw')
    expect(childThrow.thrown).toMatchObject({ message: 'child throw' })
    expect(childThrow.log).toEqual([...reads, ...captureReads, ...clears, 'child', ...restores])

    const saveThrow = run('fail', { phase: 'get', key: '_cstChildren' })
    expect(saveThrow.thrown).toMatchObject({ message: 'abrupt get _cstChildren' })
    expect(saveThrow.log).toEqual(reads.slice(0, 4))

    const clearThrow = run('fail', { phase: 'set', key: '_cstLeaves' })
    expect(clearThrow.thrown).toMatchObject({ message: 'abrupt set _cstLeaves' })
    expect(clearThrow.log).toEqual([
      ...reads, ...captureReads, ...clears.slice(0, 5),
    ])

    const restoreThrow = run('fail', { phase: 'set', key: '_cstLeaves', setCount: 2 })
    expect(restoreThrow.thrown).toMatchObject({ message: 'abrupt set _cstLeaves' })
    expect(restoreThrow.log).toEqual([
      ...reads, ...captureReads, ...clears, 'child', ...restores.slice(0, 5),
    ])
  })

  it('pins post-restore token materialization and grammar normal-failure versus throw', () => {
    const base = literal('x')
    const success: Combinator<unknown> = {
      ...base,
      parse(_input, pos) { return { ok: true, value: 'child', span: { start: pos, end: pos + 1 } } },
    }
    const savedLeaves: unknown[] = []
    const ctx: ParseContext = { trackLines: false, _cstLeaves: savedLeaves }
    const hostileInput = {
      slice() { throw new Error('slice after restore') },
    } as unknown as string
    expect(() => token(success).parse(hostileInput, 2, ctx)).toThrow('slice after restore')
    expect(ctx._cstLeaves).toBe(savedLeaves)

    const throwingLeaves = new Proxy([] as unknown[], {
      get(target, key, receiver) {
        if (key === 'push') return () => { throw new Error('leaf after restore') }
        return Reflect.get(target, key, receiver)
      },
    })
    const leafCtx: ParseContext = { trackLines: false, _cstLeaves: throwingLeaves }
    expect(() => token(success).parse('abc', 1, leafCtx)).toThrow('leaf after restore')
    expect(leafCtx._cstLeaves).toBe(throwingLeaves)

    const child = (throws: boolean): Combinator<unknown> => ({
      ...base,
      parse(_input, pos, inner) {
        inner._lineScannedTo = 9
        if (throws) throw new Error('grammar child throw')
        return { ok: false, expected: ['x'], span: { start: pos, end: pos } }
      },
    })
    const failedOuter: ParseContext = {
      trackLines: true, _lineIndex: { lineStarts: [0] }, _lineScannedTo: 1,
    }
    const failed = parser({ trackLines: true }, child(false)).parse('x', 0, failedOuter)
    expect(failed.ok).toBe(false)
    expect(failedOuter._lineScannedTo).toBe(9)

    const thrownOuter: ParseContext = {
      trackLines: true, _lineIndex: { lineStarts: [0] }, _lineScannedTo: 1,
    }
    expect(() => parser({ trackLines: true }, child(true)).parse('x', 0, thrownOuter))
      .toThrow('grammar child throw')
    expect(thrownOuter._lineScannedTo).toBe(1)
  })

  it('elides only a trivia scope whose direct token child shadows its lexical context', () => {
    const whitespace = regex(/ +/)
    const shadowed = token(sequence(
      literal(':'),
      not(parser({ trivia: whitespace }, token(sequence(literal('extend'), literal('('))))),
      regex(/[a-z]+/),
    ))
    const alphabet = collectLexicalAlphabet([shadowed])
    expect(alphabet.capabilities[0]!.obligations.recognition.representation).toEqual({ kind: 'complete' })
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
    expect(collectLexicalAlphabet([contextBearing]).capabilities[0]!.obligations.recognition.representation)
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

  it('keeps equal and shorter prefix views compatible without changing PEG arm order', () => {
    const full = token(literal('ab'))
    const routed = dispatch(
      full,
      when('ab', literal('!')),
      otherwise(literal('?')),
    )
    const root = choice(literal('a'), routed, literal('z'))
    const alphabet = collectLexicalAlphabet([root])
    const site = alphabet.decisions.find(decision =>
      alphabet.capabilities[decision.siteId]!.parser === root)!
    const family = alphabet.decisionFamilies.find(entry =>
      entry.ir.kind === 'literal' && entry.ir.value === 'ab')!
    const plan = site.families.find(entry => entry.familyId === family.id)!
    expect(plan.arms.map(arm => arm.armId)).toEqual([0, 1, 2])
    const prefixAcceptance = plan.arms[0]!.acceptance
    expect(prefixAcceptance.kind).toBe('outcomes')
    if (prefixAcceptance.kind !== 'outcomes') throw new Error('test setup: prefix arm')
    const prefix = alphabet.decisionOutcomes.find(outcome =>
      outcome.id === prefixAcceptance.outcomeIds[0])!
    expect(prefix.view).toMatchObject({
      kind: 'language', relation: 'prefix', ir: { kind: 'literal', value: 'a' },
    })
    expect(plan.arms[1]!.acceptance).toEqual({ kind: 'unrestricted' })
    expect(plan.arms[2]!.acceptance).toEqual({ kind: 'impossible' })

    expect(() => assertLexicalCapabilityClosure([root], {
      capabilities: alphabet.capabilities,
      capabilityLanguages: alphabet.capabilityLanguages,
      bindingEdges: alphabet.bindingEdges,
      decisionFamilies: alphabet.decisionFamilies,
      decisionOutcomes: alphabet.decisionOutcomes.filter(outcome => outcome.id !== prefix.id),
      decisions: alphabet.decisions,
    })).toThrow('lexical capability census is incomplete')
    // RED provenance: dropping the `a` prefix view made the family appear to
    // have only the longest `ab` end, which reverses this ordered choice on `ab`.
  })

  it('keeps a shorter arm as a prefix of a longest-first keyword family', () => {
    const selector = token(keywords(['a', 'ab']))
    const routed = dispatch(selector, otherwise(literal('!')))
    const root = choice(literal('a'), routed)
    const alphabet = collectLexicalAlphabet([root])
    const site = alphabet.decisions.find(decision =>
      alphabet.capabilities[decision.siteId]!.parser === root)!
    const family = alphabet.decisionFamilies.find(entry =>
      entry.ir.kind === 'keywords' && entry.ir.words.includes('ab'))!
    const plan = site.families.find(entry => entry.familyId === family.id)!
    const acceptance = plan.arms[0]!.acceptance
    expect(acceptance.kind).toBe('outcomes')
    if (acceptance.kind !== 'outcomes') throw new Error('test setup: keyword prefix')
    expect(alphabet.decisionOutcomes.find(outcome =>
      outcome.id === acceptance.outcomeIds[0])!.view).toMatchObject({ relation: 'prefix' })
    // RED provenance: treating every boundary-free keyword family as fixed-end
    // publishes equality, even though its longest-first recognizer consumes ab.
  })

  it('uses the authored sticky regex end for exact decision-language inclusion', () => {
    const assertUnrestricted = (
      selector: Combinator<string>,
      value: string,
      familyPredicate: (entry: { ir: unknown }) => boolean,
    ): void => {
      const routed = dispatch(selector, otherwise(literal('!')))
      const root = choice(literal(value), routed)
      const alphabet = collectLexicalAlphabet([root])
      const site = alphabet.decisions.find(decision =>
        alphabet.capabilities[decision.siteId]!.parser === root)!
      const family = alphabet.decisionFamilies.find(familyPredicate)!
      const plan = site.families.find(entry => entry.familyId === family.id)!
      expect(plan.arms[0]!.acceptance).toEqual({ kind: 'unrestricted' })
    }
    const regexFamily = (source: string) => (entry: { ir: unknown }): boolean => {
      const ir = entry.ir as { kind?: string; source?: string }
      return ir.kind === 'regex' && ir.source === source
    }
    assertUnrestricted(token(regex(/a|ab/)), 'ab', regexFamily('a|ab'))
    assertUnrestricted(token(regex(/a$/m)), 'a\n', regexFamily('a$'))
    assertUnrestricted(token(regex(/[a-z]+/)), 'red', regexFamily('[a-z]+'))
    assertUnrestricted(token(regex(/foo$/)), 'foo', regexFamily('foo$'))
    assertUnrestricted(
      token(keywords(['foo'], { boundary: 'A-Za-z' })),
      'foo',
      entry => (entry.ir as { kind?: string; boundary?: string }).kind === 'keywords'
        && (entry.ir as { boundary?: string }).boundary === 'A-Za-z',
    )
    // RED provenance: wrapping either regex in `^(?:...)$` lets the engine
    // backtrack/stop at a multiline end. Isolated exact samples also miss that
    // a family can extend (`redx`) or reject on following input (`fooX`).
  })

  it('requires total ASCII case inclusion before publishing an equal view', () => {
    for (const folded of [
      literal('a', { caseInsensitive: true }),
      keywords(['red'], { caseInsensitive: true }),
    ]) {
      const spelling = folded._def.tag === 'literal' ? 'a' : 'red'
      const selector = token(regex(new RegExp(spelling)))
      const routed = dispatch(selector, otherwise(literal('!')))
      const root = choice(folded, routed)
      const alphabet = collectLexicalAlphabet([root])
      const site = alphabet.decisions.find(decision =>
        alphabet.capabilities[decision.siteId]!.parser === root)!
      const family = alphabet.decisionFamilies.find(entry =>
        entry.ir.kind === 'regex' && entry.ir.source === spelling)!
      const plan = site.families.find(entry => entry.familyId === family.id)!
      expect(plan.arms[0]!.acceptance).toEqual({ kind: 'unrestricted' })
    }
    for (const familyRegex of [/\x61/, /[\u0061]/]) {
      const folded = keywords(['a'], { caseInsensitive: true })
      const selector = token(regex(familyRegex))
      const root = choice(folded, dispatch(selector, otherwise(literal('!'))))
      const alphabet = collectLexicalAlphabet([root])
      const site = alphabet.decisions.find(decision =>
        alphabet.capabilities[decision.siteId]!.parser === root)!
      const family = alphabet.decisionFamilies.find(entry =>
        entry.ir.kind === 'regex' && entry.ir.source === familyRegex.source)!
      const plan = site.families.find(entry => entry.familyId === family.id)!
      expect(plan.arms[0]!.acceptance).toEqual({ kind: 'unrestricted' })
    }
    {
      const folded = keywords(['ä'], { caseInsensitive: true })
      const selector = token(regex(/ä/))
      const root = choice(folded, dispatch(selector, otherwise(literal('!'))))
      const alphabet = collectLexicalAlphabet([root])
      const site = alphabet.decisions.find(decision =>
        alphabet.capabilities[decision.siteId]!.parser === root)!
      const family = alphabet.decisionFamilies.find(entry =>
        entry.ir.kind === 'regex' && entry.ir.source === 'ä')!
      const plan = site.families.find(entry => entry.familyId === family.id)!
      expect(plan.arms[0]!.acceptance).toEqual({ kind: 'unrestricted' })
    }
    {
      const folded = keywords(['ä'], { caseInsensitive: true, boundary: 'äÄ' })
      const selector = token(regex(/[äÄ]+/))
      const routed = dispatch(selector, when('ä', literal('!')), otherwise(literal('?')))
      const root = choice(folded, routed)
      const alphabet = collectLexicalAlphabet([root])
      const site = alphabet.decisions.find(decision =>
        alphabet.capabilities[decision.siteId]!.parser === root)!
      const family = alphabet.decisionFamilies.find(entry =>
        entry.ir.kind === 'regex' && entry.ir.source === '[äÄ]+')!
      const plan = site.families.find(entry => entry.familyId === family.id)!
      expect(plan.arms[0]!.acceptance).toEqual({ kind: 'unrestricted' })
    }
    // RED provenance: testing only canonical lowercase maps `a`/`red` to a
    // case-sensitive family even though `A`/`RED` still enter the CI arm;
    // escaped ASCII spellings must be decoded before proving case stability.
    // Non-ASCII `/i` has larger fold classes (ä/Ä, sigma/final-sigma), so this
    // bounded ASCII proof deliberately declines those arms and partitions.
  })

  it('declines continuation proofs that require astral Unicode code points', () => {
    const astral = '\u{10000}'
    const arm = keywords([astral], { boundary: 'A-Za-z' })
    const selector = token(regex(/[\u{10000}]+/u))
    const root = choice(arm, dispatch(selector, otherwise(literal('!'))))
    const alphabet = collectLexicalAlphabet([root])
    const site = alphabet.decisions.find(decision =>
      alphabet.capabilities[decision.siteId]!.parser === root)!
    const family = alphabet.decisionFamilies.find(entry =>
      entry.ir.kind === 'regex' && entry.ir.source === '[\\u{10000}]+')!
    const plan = site.families.find(entry => entry.familyId === family.id)!
    expect(plan.arms[0]!.acceptance).toEqual({ kind: 'unrestricted' })
    // RED provenance: a BMP-only continuation loop sees no matching code unit
    // and falsely treats a boundary that omits U+10000 as a total cover.
  })

  it('declines continuation proofs with position-sensitive prefix assertions', () => {
    const arm = keywords(['red'], { boundary: 'A-Za-z' })
    const selector = token(regex(/\b[a-z]+/))
    const decision = choice(arm, dispatch(selector, otherwise(literal('!'))))
    const root = sequence(literal('x'), decision)
    const alphabet = collectLexicalAlphabet([root])
    const site = alphabet.decisions.find(entry =>
      alphabet.capabilities[entry.siteId]!.parser === decision)!
    const family = alphabet.decisionFamilies.find(entry =>
      entry.ir.kind === 'regex' && entry.ir.source === '\\b[a-z]+')!
    const plan = site.families.find(entry => entry.familyId === family.id)!
    expect(plan.arms[0]!.acceptance).toEqual({ kind: 'unrestricted' })
    // RED provenance: after the leading `x`, \b rejects while the authored
    // keyword still matches; a trailing-class-only proof skips the valid arm.
  })

  it('keeps grouped, overlapping and otherwise dispatch routes source ordered', () => {
    const selector = token(regex(/[a-z]+/))
    const root = dispatch(
      selector,
      when(['a', 'ab'], literal('!')),
      when(startsWith('a'), literal('?')),
      when(startsWith('a'), literal(':')),
      otherwise(literal('.')),
    )
    const alphabet = collectLexicalAlphabet([root])
    const site = alphabet.decisions.find(decision =>
      alphabet.capabilities[decision.siteId]!.parser === root)!
    expect(site.precisionNotes).toEqual([])
    expect(site.fallback).toBe('unrestricted')
    expect(site.families).toHaveLength(1)
    const arms = site.families[0]!.arms
    expect(arms.map(arm => arm.armId)).toEqual([0, 1, 2, 3])
    expect(arms[0]!.acceptance).toMatchObject({ kind: 'outcomes', outcomeIds: expect.any(Array) })
    if (arms[0]!.acceptance.kind !== 'outcomes') throw new Error('test setup: exact arm')
    expect(arms[0]!.acceptance.outcomeIds).toHaveLength(2)
    if (arms[1]!.acceptance.kind !== 'outcomes') throw new Error('test setup: matcher arm')
    expect(alphabet.decisionOutcomes.find(outcome =>
      outcome.id === (arms[1]!.acceptance.kind === 'outcomes'
        ? arms[1]!.acceptance.outcomeIds[0] : -1))!.view)
      .toMatchObject({ kind: 'predicate', match: { kind: 'startsWith', value: 'a' } })
    expect(arms[2]!.acceptance).toEqual(arms[1]!.acceptance)
    expect(arms[3]!.acceptance).toEqual({
      kind: 'otherwise',
      excludingOutcomeIds: [...new Set([
        ...arms[0]!.acceptance.outcomeIds,
        ...arms[1]!.acceptance.outcomeIds,
        ...(arms[2]!.acceptance.kind === 'outcomes' ? arms[2]!.acceptance.outcomeIds : []),
      ])].sort((a, b) => a - b),
    })
    // Duplicate predicates share one atomic outcome identity, while armId 1/2
    // remain distinct ordered routes. RED provenance: route dedup drops arm 2.
  })

  it('does not collapse case-folded arm languages into a case-sensitive outcome partition', () => {
    const selector = token(regex(/[A-Za-z]+/))
    const routed = dispatch(
      selector,
      when('red', literal('!')),
      otherwise(literal('?')),
    )
    const folded = keywords(['red'], { caseInsensitive: true, boundary: 'A-Za-z' })
    const root = choice(folded, routed)
    const alphabet = collectLexicalAlphabet([root])
    const site = alphabet.decisions.find(decision =>
      alphabet.capabilities[decision.siteId]!.parser === root)!
    const family = alphabet.decisionFamilies.find(entry =>
      entry.ir.kind === 'regex' && entry.ir.source === '[A-Za-z]+')!
    const plan = site.families.find(entry => entry.familyId === family.id)!
    const foldedAcceptance = plan.arms[0]!.acceptance
    expect(foldedAcceptance.kind).toBe('outcomes')
    if (foldedAcceptance.kind !== 'outcomes') throw new Error('test setup: folded arm')
    expect(alphabet.decisionOutcomes.find(outcome =>
      outcome.id === foldedAcceptance.outcomeIds[0])!.view)
      .toMatchObject({ kind: 'language', relation: 'equal' })
    // `red` selects the exact route while `RED` selects otherwise. Mapping one
    // canonical spelling to either outcome would incorrectly skip this CI arm.
    // RED provenance: removing predicatePartitionStableFor maps the arm to the
    // CS exact-predicate outcome instead of this independent CI language view.
  })

  it('keeps otherwise complements local when two dispatches share a family', () => {
    const selector = token(regex(/[a-z]+/))
    const left = dispatch(selector, when('a', literal('!')), otherwise(literal('?')))
    const right = dispatch(selector, when('b', literal(':')), otherwise(literal('.')))
    const root = choice(left, right)
    const alphabet = collectLexicalAlphabet([root])
    const site = alphabet.decisions.find(decision =>
      alphabet.capabilities[decision.siteId]!.parser === root)!
    expect(site.precisionNotes).toContainEqual(expect.stringContaining('distinct site-local outcome partitions'))
    expect(site.families).toHaveLength(1)
    expect(site.families[0]!.arms.map(arm => arm.acceptance)).toEqual([
      { kind: 'unrestricted' }, { kind: 'unrestricted' },
    ])
    // RED provenance: unioning both classifiers' exclusions turns neither
    // authored otherwise route into its true site-local complement.
  })

  it('keeps reused decision occurrences context-local and admits imprecise relations unrestricted', () => {
    const shared = choice(choice(literal('a'), literal('b')), token(literal('c')))
    const trivia = regex(/ +/)
    const root = choice(
      parser({ trivia }, shared),
      parser({ trivia: null }, shared),
    )
    const alphabet = collectLexicalAlphabet([root])
    const occurrences = alphabet.decisions.filter(decision =>
      alphabet.capabilities[decision.siteId]!.parser === shared)
    expect(occurrences).toHaveLength(2)
    expect(new Set(occurrences.map(entry => entry.contextKey)).size).toBe(2)
    expect(occurrences.every(entry => entry.precisionNotes.some(reason =>
      reason.includes('nested leading choice')))).toBe(true)
    expect(alphabet.capabilities.filter(site => site.parser === shared)
      .every(site => site.obligations.recognition.representation.kind === 'complete')).toBe(true)
    expect(occurrences.every(entry => entry.fallback === 'unrestricted')).toBe(true)
    // RED provenance: deduplicating by parser/language alone collapses these two
    // outer lexical contexts. A missing nested-union proof is cost-only: the
    // replacement body still enters every authored arm in PEG order.
  })

  it('keeps an exact selector family when an effectful wrapper declines only predecision precision', () => {
    const selectorToken = token(regex(/[a-z]+/))
    const selector = parser({ trivia: regex(/ +/) }, selectorToken)
    const root = dispatch(selector, otherwise(routed()))
    const alphabet = collectLexicalAlphabet([root])
    const site = alphabet.decisions.find(decision =>
      alphabet.capabilities[decision.siteId]!.parser === root)!
    expect(site.fallback).toBe('unrestricted')
    expect(site.families).toEqual([])
    expect(site.precisionNotes).toContainEqual(expect.stringContaining('grammar wrapper changes lexical context'))
    expect(alphabet.capabilities.find(capability => capability.parser === root)!
      .obligations.recognition.representation).toEqual({ kind: 'complete' })
    expect(alphabet.sites.find(tokenSite => tokenSite.parser === selectorToken)!.refusal).toBeUndefined()
    expect(alphabet.decisionFamilies.some(family =>
      family.ir.kind === 'regex' && family.ir.source === '[a-z]+')).toBe(true)
    // RED provenance: classifying the wrapper note as a semantic gap makes the
    // dispatch incomplete despite its exact selector token; dropping the token
    // family makes the final assertion fail even though fallback stays broad.
  })

  it('closes every lexical IR kind and makes kind, context, and occurrence omissions RED', () => {
    const lexicalRoots = [
      token(literal('a')),
      token(keywords(['if', 'in'], { boundary: 'A-Za-z' })),
      token(regex(/[a-z]+/)),
      token(sequence(literal('s'), regex(/[0-9]+/))),
      token(choice(literal('c'), literal('d'))),
      token(many(literal('r'), { min: 1, max: 2 })),
      token(sequence(peek(literal('p')), literal('p'))),
      token(balanced('(', ')')),
    ]
    const lexical = collectLexicalAlphabet(lexicalRoots)
    type TestIr = (typeof lexical.decisionFamilies)[number]['ir']
    const irKinds = (ir: TestIr): string[] => [ir.kind, ...(
      ir.kind === 'sequence' ? ir.parts.flatMap(irKinds)
        : ir.kind === 'choice' ? ir.arms.flatMap(irKinds)
          : ir.kind === 'repeat' || ir.kind === 'assert' ? irKinds(ir.body)
            : ir.kind === 'balanced' ? ir.skip.flatMap(irKinds)
              : []
    )]
    expect(new Set(lexical.decisionFamilies.flatMap(family => irKinds(family.ir)))).toEqual(new Set([
      'literal', 'keywords', 'regex', 'sequence', 'choice', 'repeat', 'assert', 'balanced',
    ]))
    expect(lexical.capabilities.every(site => site.obligations.recognition.representation.kind === 'complete')).toBe(true)
    for (const kind of ['literal', 'keywords', 'regex', 'sequence', 'choice', 'repeat', 'assert', 'balanced'] as const) {
      expect(() => assertLexicalCapabilityClosure(lexicalRoots, {
        capabilities: lexical.capabilities,
        capabilityLanguages: lexical.capabilityLanguages,
        bindingEdges: lexical.bindingEdges,
        decisionFamilies: lexical.decisionFamilies.filter(family => !irKinds(family.ir).includes(kind)),
        decisionOutcomes: lexical.decisionOutcomes,
        decisions: lexical.decisions,
      })).toThrow('lexical capability census is incomplete')
    }

    const ws = regex(/ +/)
    const shared = choice(token(regex(/[a-z]+/)), literal('!'))
    const contextRoots = [
      shared,
      parser({ trivia: ws }, shared),
      parser({ trivia: null }, shared),
      parser({ trivia: ws, trackLines: true }, shared),
      parser({ trivia: ws, captureTrivia: true }, shared),
      parser({ trivia: ws, rootCapture: 'opaque' }, shared),
      withCtx({ dialect: 'test' }, shared),
    ]
    const contextual = collectLexicalAlphabet(contextRoots)
    const occurrences = contextual.capabilities.filter(site => site.parser === shared)
    expect(new Set(occurrences.map(site => site.contextKey)).size).toBeGreaterThanOrEqual(6)
    expect(occurrences.every(site => site.obligations.recognition.representation.kind === 'complete')).toBe(true)
    const omitted = occurrences[occurrences.length >> 1]!
    expect(() => assertLexicalCapabilityClosure(contextRoots, {
      capabilities: contextual.capabilities.filter(site => site !== omitted),
      capabilityLanguages: contextual.capabilityLanguages,
      bindingEdges: contextual.bindingEdges,
      decisionFamilies: contextual.decisionFamilies,
      decisionOutcomes: contextual.decisionOutcomes,
      decisions: contextual.decisions,
    })).toThrow('lexical capability census is incomplete')
    const decision = contextual.decisions.find(site => site.siteId === omitted.id)!
    expect(() => assertLexicalCapabilityClosure(contextRoots, {
      capabilities: contextual.capabilities,
      capabilityLanguages: contextual.capabilityLanguages,
      bindingEdges: contextual.bindingEdges,
      decisionFamilies: contextual.decisionFamilies,
      decisionOutcomes: contextual.decisionOutcomes,
      decisions: contextual.decisions.filter(site => site !== decision),
    })).toThrow('lexical capability census is incomplete')
    // RED provenance: each plant deletes one semantically distinct authority:
    // a canonical recognizer kind, one context-local occurrence, or its ordered
    // decision relation. None may disappear behind unrestricted admission.
  })

  it('fails closed when a final composed decision arm is omitted from the outcome IR', () => {
    const base = rules(g => ({
      Entry: sequence(g.Word, literal('!')),
      Word: choice(literal('old'), token(literal('older'))),
    }))
    const delta = rules(() => ({
      Word: choice(literal('a'), token(literal('ab'))),
    }))
    const composed = compose([base, delta]) as unknown as Record<string, unknown>
    const winners = composedCoverageRules(composed)!
    const names = Object.keys(winners).sort()
    const roots = names.map(name => winners[name]!)
    const resolve = (name: string): Combinator<unknown> | undefined => winners[name]
    const alphabet = collectLexicalAlphabet(roots, resolve)
    const finalWord = alphabet.decisions.find(decision =>
      alphabet.capabilities[decision.siteId]!.parser === winners.Word)!
    expect(finalWord.families.some(family => family.arms.length === 2)).toBe(true)
    const planted = alphabet.decisions.map(decision => decision !== finalWord ? decision : ({
      ...decision,
      families: decision.families.map((family, index) => index === 0
        ? { ...family, arms: family.arms.slice(1) }
        : family),
    }))
    expect(() => assertLexicalCapabilityClosure(roots, {
      capabilities: alphabet.capabilities,
      capabilityLanguages: alphabet.capabilityLanguages,
      bindingEdges: alphabet.bindingEdges,
      decisionFamilies: alphabet.decisionFamilies,
      decisionOutcomes: alphabet.decisionOutcomes,
      decisions: planted,
    }, resolve)).toThrow('lexical capability census is incomplete')
    // RED provenance: an outcome walk over pre-compose or filtered arms can
    // retain the old decision while the final grammar executes the replacement.
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
    const canonicalFamily = alphabet.decisionFamilies.find(family =>
      family.semanticKey === JSON.stringify(alphabet.recognizers[0]!.ir))!
    expect(canonicalFamily.id).toBeGreaterThanOrEqual(3)
    expect(alphabet.recognizers[0]!.capabilityFamilyId).toBe(canonicalFamily.id)
    expect(alphabet.decisionOutcomes.every(outcome =>
      outcome.id >= 3 + alphabet.decisionFamilies.length)).toBe(true)
    expect(alphabet.families[0]!.recognizerId).toBe(alphabet.recognizers[0]!.id)
    expect(alphabet.sites).not.toContainEqual(expect.objectContaining({ parser: identifier }))
    expect(alphabet.sites).not.toContainEqual(expect.objectContaining({ parser: open }))
    expect(Object.keys(alphabet)).not.toContain('primitiveKernels')

    // RED provenance: assigning decision families from a separate zero-based
    // site walk makes this same IR acquire two unrelated family identities.

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
        recognition: {
          representation: { kind: 'impossible', proof: expect.stringContaining('positive width') },
        },
        diagnostics: { representation: { kind: 'gap' } },
      },
    })
  })
})
