/**
 * Independent final-grammar capability census.
 *
 * Run with:
 *   JESS_ROOT=/private/tmp/jess-parseman-origin-dev node --import ./bench/jess/register.mjs --import tsx bench/jess/capability-closure.ts
 *
 * This intentionally reads raw ParserDef fields and never imports the production
 * candidate/child walker. PM_CAPABILITY_ORACLE_PLANT=omit-post-compose must fail.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type { Combinator, ParserDef } from '../../src/types.ts'
import {
  choice, compose, dispatch, literal, regex, routed, rules, run, scanTo, sequence,
  token, transform, when, type ParseContext,
} from '../../src/index.ts'
import { composedCoverageRules } from '../../src/compiler/linker.ts'
import { branchUsesRouted } from '../../src/combinators/dispatch.ts'
import { firstSetOf, matchesEmpty } from '../../src/combinators/first-set.ts'
import {
  assertLexicalCapabilityClosure, collectLexicalAlphabet,
} from '../../src/compiler/token-alphabet.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { assertParseman, JESS_ROOT, loadGrammar } from './grammars.ts'

type Comb = Combinator<unknown>
type Atom = 'terminal' | 'token' | 'choice' | 'dispatch'
type Context = {
  trivia: Comb | undefined
  scanSkip: readonly Comb[]
  trackLines: boolean
  captureTrivia: boolean
  rootCapture: boolean
  dynamicState: boolean
}
type Row = {
  atom: Atom
  parser: Comb
  path: string
  outer: string
  recognition: string
  context: Context
}
type RawScanConsumer = {
  kind: 'scanTo' | 'balanced'
  raw: boolean
  ownSkip: readonly Comb[]
  context: Context
}

const EXPECTED = {
  css: {
    total: 842,
    counts: { terminal: 645, token: 39, choice: 147, dispatch: 11 },
    contexts: 9,
    digest: '797eacdf3610fff1b9da3e0052a7ade72891bba21924a88639a334385d1ac8fe',
    scanConsumers: 90,
    scanDigest: '33758750439a126605197b7197ef038ce0636a919ece8ef3346686719a491640',
    scanKinds: { scanTo: 63, balanced: 27 },
    contextSnapshots: 9,
    ownSkipPlans: 9,
    bindingEdges: 2705,
    pendingForbidden: 88,
    decisionEdges: 2507,
    decisionDigest: '4cca29e12048e2c9f2c42ecc309f176b978963d39dcc51a5f2173daa30f5e1c9',
    decisions: 158,
    finalExclusive: 57,
    routedRoutes: 64,
  },
  less: {
    total: 1687,
    counts: { terminal: 1178, token: 62, choice: 418, dispatch: 29 },
    contexts: 11,
    digest: '6d97393cf6316dd57eacf4710db88119243050bcac3c9338ba524eacbc4178e0',
    scanConsumers: 7,
    scanDigest: 'e3e8d56a43208c106b4fdc2fabf349be4ac850f88439df55d3e0464c4b039ecf',
    scanKinds: { scanTo: 4, balanced: 3 },
    contextSnapshots: 11,
    ownSkipPlans: 1,
    bindingEdges: 6819,
    pendingForbidden: 217,
    decisionEdges: 6540,
    decisionDigest: 'eb139fec0fc365f4bc354dcc9332dc453c309800f464c2a826d9f6d3468fc924',
    decisions: 447,
    finalExclusive: 107,
    routedRoutes: 89,
  },
} as const

const isComb = (value: unknown): value is Comb =>
  value !== null && typeof value === 'object' && '_def' in value && 'parse' in value

function rawEdges(parser: Comb): Array<{ label: string; parser: Comb }> {
  const def = parser._def as unknown as Record<string, unknown>
  const out: Array<{ label: string; parser: Comb }> = []
  const read = (value: unknown, label: string, depth: number): void => {
    if (isComb(value)) { out.push({ label, parser: value }); return }
    if (depth >= 2 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) read(value[i], `${label}[${i}]`, depth + 1)
    } else {
      for (const key of Object.keys(value).sort()) {
        read((value as Record<string, unknown>)[key], `${label}.${key}`, depth + 1)
      }
    }
  }
  for (const key of Object.keys(def).filter(key => key !== 'tag').sort()) read(def[key], key, 0)
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

function wrapsReference(winner: Comb, reference: Comb): boolean {
  let current = winner
  const seen = new Set<Comb>()
  while (!seen.has(current)) {
    if (current === reference) return true
    seen.add(current)
    const def = current._def
    if (def.tag !== 'grammar' && def.tag !== 'trivia') return false
    current = def.parser
  }
  return false
}

function lazyWinner(parser: Comb, resolve: (name: string) => Comb | undefined): Comb | undefined {
  const def = parser._def
  if (def.tag !== 'lazy') return undefined
  const name = (parser as Comb & { _ruleName?: string })._ruleName
  if (name !== undefined) {
    const winner = resolve(name)
    if (winner !== undefined && !wrapsReference(winner, parser)) return winner
  }
  try { return def.thunk() } catch { return undefined }
}

function atomOf(def: ParserDef): Atom | undefined {
  if (def.tag === 'literal' || def.tag === 'keywords' || def.tag === 'regex') return 'terminal'
  if (def.tag === 'token' || def.tag === 'choice' || def.tag === 'dispatch') return def.tag
  return undefined
}

/** Independent scanner ownership walk over raw ParserDef edges. */
function rawScanConsumers(
  root: Comb,
  initialContext: Context,
  resolve: (name: string) => Comb | undefined,
  isSeparateOccurrence: (parser: Comb, context: Context) => boolean,
): RawScanConsumer[] {
  const out: RawScanConsumer[] = []
  const stack = new Set<Comb>()
  const balanced = (parser: Comb): {
    raw: boolean
    ownSkip: readonly Comb[]
  } | undefined => {
    let current = parser
    const seen = new Set<Comb>()
    while (!seen.has(current)) {
      seen.add(current)
      const spec = (current as Comb & { _balancedSpec?: {
        raw: boolean
        ownSkip: readonly Comb[]
      } })._balancedSpec
      if (spec !== undefined) return spec
      if (current._def.tag !== 'token') return undefined
      current = current._def.parser
    }
    return undefined
  }
  const visit = (parser: Comb, first: boolean, context: Context): void => {
    if (stack.has(parser)) return
    const def = parser._def
    if (!first && isSeparateOccurrence(parser, context)) return
    let childContext = context
    if (def.tag === 'grammar') childContext = {
      ...context,
      trivia: def.clearTrivia ? undefined : (def.triviaParser ?? context.trivia),
      trackLines: context.trackLines || def.trackLines,
      captureTrivia: context.captureTrivia || def.captureTrivia === true,
      rootCapture: context.rootCapture || def.rootCapture === 'opaque',
    }
    else if (def.tag === 'withCtx') childContext = { ...context, dynamicState: true }
    else if (def.tag === 'token') childContext = { ...context, trivia: undefined }
    else if (def.tag === 'trivia') childContext = { ...context, trivia: undefined }
    const spec = balanced(parser)
    if (spec !== undefined) {
      out.push({ kind: 'balanced', raw: spec.raw, ownSkip: spec.ownSkip, context: childContext })
      return
    }
    if (def.tag === 'scanTo') {
      out.push({ kind: 'scanTo', raw: def.raw, ownSkip: def.raw ? [] : def.skip, context })
      return
    }
    stack.add(parser)
    const edges = def.tag === 'lazy'
      ? [lazyWinner(parser, resolve)].filter((entry): entry is Comb => entry !== undefined)
        .map(parser => ({ parser }))
      : rawEdges(parser)
    for (const edge of edges) visit(edge.parser, false, childContext)
    stack.delete(parser)
  }
  visit(root, true, initialContext)
  return out.sort((a, b) =>
    a.kind.localeCompare(b.kind) || Number(a.raw) - Number(b.raw) || a.ownSkip.length - b.ownSkip.length)
}

function census(
  roots: ReadonlyArray<readonly [string, Comb]>,
  resolve: (name: string) => Comb | undefined,
): { rows: Row[]; bindingEdges: number; contextKey: (context: Context) => string } {
  const ids = new Map<Comb, number>()
  const id = (parser: Comb): number => {
    const prior = ids.get(parser)
    if (prior !== undefined) return prior
    const next = ids.size
    ids.set(parser, next)
    return next
  }
  const contextKey = (ctx: Context): string => [
    `trivia=${ctx.trivia === undefined ? '-' : id(ctx.trivia)}`,
    `scan=${ctx.scanSkip.map(id).join(',') || '-'}`,
    `lines=${ctx.trackLines ? 1 : 0}`,
    `capture=${ctx.captureTrivia ? 1 : 0}`,
    `root=${ctx.rootCapture ? 'opaque' : '-'}`,
    `state=${ctx.dynamicState ? 1 : 0}`,
  ].join('|')
  const seen = new Set<string>()
  const rows = new Map<string, Row>()
  let bindingEdges = 0
  let plantedOmission = false
  const visit = (parser: Comb, context: Context, path: string): void => {
    const outer = contextKey(context)
    const state = `${id(parser)}\u0000${outer}`
    const atom = atomOf(parser._def)
    if (atom !== undefined) {
      const recognitionContext = atom === 'token'
        ? { ...context, trivia: undefined, captureTrivia: false }
        : context
      const key = `${id(parser)}\u0000${outer}`
      const prior = rows.get(key)
      if (prior === undefined) rows.set(key, {
        atom, parser, path, outer, recognition: contextKey(recognitionContext), context,
      })
      else if (path < prior.path) prior.path = path
      if (atom === 'token') return
    }
    if (seen.has(state)) return
    seen.add(state)
    const def = parser._def
    let childContext = context
    if (def.tag === 'grammar') childContext = {
      ...context,
      trivia: def.clearTrivia ? undefined : (def.triviaParser ?? context.trivia),
      trackLines: context.trackLines || def.trackLines,
      captureTrivia: context.captureTrivia || def.captureTrivia === true,
      rootCapture: context.rootCapture || def.rootCapture === 'opaque',
    }
    if (def.tag === 'withCtx') childContext = { ...context, dynamicState: true }
    const omitThisWinner = def.tag === 'lazy'
      && (process.env.PM_CAPABILITY_ORACLE_PLANT === 'omit-post-compose'
        || process.env.PM_CAPABILITY_ORACLE_PLANT === 'omit-final-winner-edge')
      && !plantedOmission
    if (omitThisWinner) plantedOmission = true
    const edges = def.tag === 'lazy'
      ? (omitThisWinner ? [] : [
          { label: `winner:${(parser as Comb & { _ruleName?: string })._ruleName ?? '?'}`, parser: lazyWinner(parser, resolve) },
        ].filter((edge): edge is { label: string; parser: Comb } => edge.parser !== undefined))
      : rawEdges(parser)
    for (const edge of edges) {
      bindingEdges++
      visit(edge.parser, childContext, `${path}/${edge.label}`)
    }
  }
  for (const [name, root] of [...roots].sort((a, b) => a[0].localeCompare(b[0]))) visit(root, {
    trivia: root._meta.grammarTrivia,
    scanSkip: root._meta.grammarScanSkip ?? [],
    trackLines: root._meta.grammarTrackLines === true,
    captureTrivia: false,
    rootCapture: false,
    dynamicState: false,
  }, `rule:${name}`)
  return {
    rows: [...rows.values()].sort((a, b) =>
      a.path.localeCompare(b.path) || a.recognition.localeCompare(b.recognition) || a.atom.localeCompare(b.atom)),
    bindingEdges,
    contextKey,
  }
}

function counts(rows: readonly Row[]): Record<Atom, number> {
  const out = { terminal: 0, token: 0, choice: 0, dispatch: 0 }
  for (const row of rows) out[row.atom]++
  return out
}

function finalExclusive(parser: Comb, resolve: (name: string) => Comb | undefined): boolean {
  assert.equal(parser._def.tag, 'choice')
  const occupied = new Int32Array(128)
  let highOwner = false
  for (let arm = 0; arm < parser._def.parsers.length; arm++) {
    const child = parser._def.parsers[arm]!
    if (matchesEmpty(child, new Set(), resolve)) return false
    const first = firstSetOf(child, new Set(), resolve)
    if (first.kind !== 'ranges') return false
    let ownsHigh = false
    for (const range of first.ranges) {
      if (range.hi >= 128) ownsHigh = true
      for (let code = Math.max(0, range.lo); code <= Math.min(127, range.hi); code++) {
        if (occupied[code] !== 0) return false
        occupied[code] = arm + 1
      }
    }
    if (ownsHigh) {
      if (highOwner) return false
      highOwner = true
    }
  }
  return true
}

function finalDecisionFacts(
  rows: readonly Row[],
  contextKey: (context: Context) => string,
  resolve: (name: string) => Comb | undefined,
): { decisions: number; finalExclusive: number; routedRoutes: number; digest: string } {
  const decisionRows: string[] = []
  let decisions = 0
  let exclusive = 0
  let routedRoutes = 0
  for (const row of rows) {
    const def = row.parser._def
    if (def.tag === 'choice') {
      decisions++
      const final = finalExclusive(row.parser, resolve)
      if (final) exclusive++
      decisionRows.push(`choice\0${row.path}\0${contextKey(row.context)}\0${def.parsers.length}\0${def.disjoint}\0${def.strategy.tag}\0${final}`)
    } else if (def.tag === 'dispatch') {
      decisions++
      const routes = [
        ...def.cases, ...(def.matchers ?? []),
        ...(def.otherwise === undefined ? [] : [{ parser: def.otherwise, usesRouted: def.otherwiseUsesRouted }]),
      ]
      routedRoutes += routes.filter(branchUsesRouted).length
      decisionRows.push(`dispatch\0${row.path}\0${contextKey(row.context)}\0${routes.length}\0${routes.map(route => Number(branchUsesRouted(route))).join(',')}`)
    }
  }
  // The digest owns the exact raw decision paths and contexts; bindingEdges is
  // asserted separately because an omitted non-decision winner can preserve it.
  return {
    decisions, finalExclusive: exclusive, routedRoutes,
    digest: createHash('sha256').update(decisionRows.join('\n')).digest('hex'),
  }
}

function proveFinalExclusiveReaderDivergence(): void {
  const calls: string[] = []
  const traced = (name: string, value: string): Comb => {
    const terminal = literal(value)
    return {
      ...terminal,
      parse(input, pos, ctx) { calls.push(name); return terminal.parse(input, pos, ctx) },
    }
  }
  const source = choice(traced('a', 'a'), traced('b', 'b'))
  const miss = source.parse('z', 0, { trackLines: false } as ParseContext)
  assert.equal(miss.ok, false)
  assert.deepEqual(calls, ['a', 'b'])
  const program = encodeTable({ Entry: source })
  const engines = {
    reference: execRules(program).Entry!,
    closure: tableRules({ ...program, asm: [] }).Entry!,
    emitted: tableRules(program).Entry!,
  }
  for (const [engine, entry] of Object.entries(engines)) {
    calls.length = 0
    const actual = run(entry, 'z')
    assert.deepEqual({ ok: actual.ok, expected: actual.expected, span: actual.span }, {
      ok: miss.ok, expected: miss.expected, span: miss.span,
    }, `${engine} final-exclusive miss facets`)
    assert.deepEqual(calls, [], `${engine} final-exclusive miss must expose zero child entries`)
  }
}

function proveClassifyProjection(): void {
  const parser = choice(
    transform(literal('if'), value => `kw:${value}`),
    transform(transform(literal('for'), value => value), value => `kw:${value}`),
    regex(/[a-z]+/),
  )
  assert.equal(parser._def.tag, 'choice')
  assert.equal(parser._def.strategy.tag, 'greedyClassify')
  const parsed = parser.parse('if', 0, { trackLines: false } as ParseContext)
  assert.equal(parsed.ok && parsed.value,
    process.env.PM_CAPABILITY_ORACLE_PLANT === 'drop-classify-transform' ? 'if' : 'kw:if')
}

function proveRoutedProtocol(): void {
  const events: string[] = []
  const outer = { value: 'outer', span: { start: 7, end: 8 } }
  let slot: unknown = outer
  const ctx = { trackLines: false } as ParseContext
  Object.defineProperty(ctx, '_routed', {
    configurable: true,
    get() { events.push('get'); return slot },
    set(value) { events.push(value === outer ? 'restore' : 'install'); slot = value },
  })
  const parser = dispatch(literal('x'), when('x', sequence(routed(), literal('!'))))
  assert.equal(parser.parse('x!', 0, ctx).ok, true)
  assert.deepEqual(events, ['get', 'install', 'get', 'restore'])

  const installEvents: string[] = []
  const throwing = { trackLines: false } as ParseContext
  Object.defineProperty(throwing, '_routed', {
    configurable: true,
    get() { installEvents.push('get'); return undefined },
    set() { installEvents.push('install'); throw new Error('setter boom') },
  })
  assert.throws(() => parser.parse('x!', 0, throwing), /setter boom/)
  assert.deepEqual(installEvents, ['get', 'install'])

  const plainEvents: string[] = []
  const plain = { trackLines: false } as ParseContext
  Object.defineProperty(plain, '_routed', {
    configurable: true,
    get() { plainEvents.push('get'); return outer },
  })
  assert.equal(dispatch(literal('x'), when('x', literal('!'))).parse('x!', 0, plain).ok, true)
  assert.deepEqual(plainEvents, ['get'])

  const branchEvents: string[] = []
  let branchSlot: unknown = outer
  const branchContext = { trackLines: false } as ParseContext
  Object.defineProperty(branchContext, '_routed', {
    configurable: true,
    get() { branchEvents.push('get'); return branchSlot },
    set(value) { branchEvents.push(value === outer ? 'restore' : 'install'); branchSlot = value },
  })
  const branchThrow = dispatch(literal('x'), when('x', transform(routed(), () => {
    branchEvents.push('branch')
    throw new Error('branch boom')
  })))
  assert.throws(() => branchThrow.parse('x', 0, branchContext), /branch boom/)
  assert.deepEqual(branchEvents, ['get', 'install', 'get', 'branch', 'restore'])

  const getterThrow = { trackLines: false } as ParseContext
  Object.defineProperty(getterThrow, '_routed', {
    configurable: true,
    get() { throw new Error('getter boom') },
  })
  assert.throws(() => dispatch(literal('x'), when('x', literal('!')))
    .parse('x!', 0, getterThrow), /getter boom/)

  let setterCalls = 0
  let restoreSlot: unknown = outer
  const restoreThrow = { trackLines: false } as ParseContext
  Object.defineProperty(restoreThrow, '_routed', {
    configurable: true,
    get() { return restoreSlot },
    set(value) {
      setterCalls++
      if (setterCalls === 2) throw new Error('restore boom')
      restoreSlot = value
    },
  })
  assert.throws(() => parser.parse('x!', 0, restoreThrow), /restore boom/)
  assert.equal(setterCalls, 2)
}

function proveFinalWinner(): void {
  const base = rules((g: Record<string, Comb>) => ({
    Entry: sequence(g.Word!, literal('!')),
    Word: token(literal('a')),
  })) as unknown as Record<string, Comb>
  const overlay = rules(() => ({ Word: token(literal('b')) })) as unknown as Record<string, Comb>
  const composed = compose([base, overlay]) as unknown as Record<string, unknown>
  const finalRules = composedCoverageRules(composed)
  assert(finalRules !== undefined)
  const result = census(Object.entries(finalRules), name => finalRules[name])
  const has = (value: string): boolean => result.rows.some(row =>
    row.atom === 'token' && row.parser._def.tag === 'token'
    && rawEdges(row.parser).some(edge => edge.parser._def.tag === 'literal' && edge.parser._def.value === value))
  assert(has('b'), 'post-compose winner was omitted')
  assert(!has('a'), 'superseded pre-compose token remained reachable')
}

function proveNestedScannerOwnership(): void {
  const trivia = literal(' ')
  const grammar = rules({ trivia }, () => ({
    NestedToken: token(token(scanTo(literal(';')))),
    NestedChoice: token(choice(scanTo(literal(';')), literal('x'))),
  })) as unknown as Record<string, Comb>
  const roots = Object.entries(grammar)
  const result = census(roots, name => grammar[name])
  const occurrences = new Map<Comb, Set<string>>()
  for (const row of result.rows) {
    let contexts = occurrences.get(row.parser)
    if (contexts === undefined) occurrences.set(row.parser, contexts = new Set())
    contexts.add(row.outer)
  }
  const raw = result.rows.flatMap(row => rawScanConsumers(
    row.parser,
    row.context,
    name => grammar[name],
    (parser, context) => occurrences.get(parser)?.has(result.contextKey(context)) === true,
  ))
  assert.equal(raw.length, 2)
  assert(raw.every(policy => policy.kind === 'scanTo' && policy.context.trivia === undefined))
  const production = collectLexicalAlphabet(roots.map(([, parser]) => parser), name => grammar[name])
  assert.equal(production.capabilities.length, 2)
  assert.equal(production.scanConsumerPolicies.length, 2)
  for (const site of production.capabilities) {
    assert.equal(site.scanConsumerPolicyIds.length, 1)
    const outer = production.contextSnapshots[site.contextSnapshotId]
    const policy = production.scanConsumerPolicies[site.scanConsumerPolicyIds[0]!]!
    const inner = production.contextSnapshots[policy.contextSnapshotId]
    assert(outer?.hasTrivia)
    assert.equal(inner?.hasTrivia, false)
    assert.notEqual(policy.contextSnapshotId, site.contextSnapshotId)
  }
}

proveFinalWinner()
proveNestedScannerOwnership()
proveFinalExclusiveReaderDivergence()
proveClassifyProjection()
proveRoutedProtocol()
const loader = await assertParseman()
for (const dialect of ['css', 'less'] as const) {
  const grammar = await loadGrammar(dialect)
  const names = Object.keys(grammar.rules).sort()
  const roots = names.map(name => [name, grammar.rules[name]!] as const)
  const result = census(roots, name => grammar.rules[name])
  const digest = createHash('sha256').update(result.rows.map(row =>
    `${row.atom}\u0000${row.path}\u0000${row.outer}\u0000${row.recognition}`).join('\n')).digest('hex')
  const occurrenceContexts = new Map<Comb, Set<string>>()
  for (const row of result.rows) {
    let contexts = occurrenceContexts.get(row.parser)
    if (contexts === undefined) occurrenceContexts.set(row.parser, contexts = new Set())
    contexts.add(row.outer)
  }
  const isSeparateOccurrence = (parser: Comb, context: Context): boolean =>
    occurrenceContexts.get(parser)?.has(result.contextKey(context)) === true
  const rawScanRows = result.rows.flatMap(row => rawScanConsumers(
    row.parser, row.context, name => grammar.rules[name], isSeparateOccurrence,
  ).map(consumer => ({
    row, consumer,
  })))
  const scanDigest = createHash('sha256').update(rawScanRows.map(({ row, consumer }) =>
    `${row.atom}\u0000${row.path}\u0000${result.contextKey(consumer.context)}\u0000${consumer.kind}\u0000${Number(consumer.raw)}\u0000${consumer.ownSkip.length}`
  ).join('\n')).digest('hex')
  const expected = EXPECTED[dialect]
  const decisionFacts = finalDecisionFacts(result.rows, context => {
    const broad = result.contextKey(context).split('|')
    return broad.map(part => part === 'root=opaque' ? 'root=1'
      : part === 'root=-' ? 'root=0'
        : part.replace(/^lines=/, 'lines=').replace(/^capture=/, 'capture=').replace(/^state=/, 'state='))
      .join('|')
  }, name => grammar.rules[name])
  // Stage-C2 authority is asserted before the broader capability rows so its
  // final-winner omission plant fails at this independent decision boundary.
  assert.equal(result.bindingEdges, expected.decisionEdges)
  assert.equal(decisionFacts.decisions, expected.decisions)
  assert.equal(decisionFacts.finalExclusive, expected.finalExclusive)
  assert.equal(decisionFacts.routedRoutes, expected.routedRoutes)
  assert.equal(decisionFacts.digest, expected.decisionDigest)
  assert.equal(result.rows.length, expected.total)
  assert.deepEqual(counts(result.rows), expected.counts)
  assert.equal(new Set(result.rows.map(row => row.recognition)).size, expected.contexts)
  assert.equal(digest, expected.digest)
  assert.equal(rawScanRows.length, expected.scanConsumers)
  assert.equal(scanDigest, expected.scanDigest)
  assert.deepEqual({
    scanTo: rawScanRows.filter(row => row.consumer.kind === 'scanTo').length,
    balanced: rawScanRows.filter(row => row.consumer.kind === 'balanced').length,
  }, expected.scanKinds)

  // Comparison occurs only after the independent raw-def census is complete.
  const production = collectLexicalAlphabet(roots.map(([, parser]) => parser), name => grammar.rules[name])
  assert.equal(production.capabilities.length, result.rows.length)
  for (const row of result.rows) assert(production.capabilities.some(site =>
    site.parser === row.parser
    && site.atom === row.atom
    && site.context.trivia === row.context.trivia
    && site.context.trackLines === row.context.trackLines
    && site.context.captureTrivia === row.context.captureTrivia
    && site.context.opaqueRootCapture === row.context.rootCapture
    && site.context.dynamicState === row.context.dynamicState
    && site.context.scanSkip.length === row.context.scanSkip.length
    && site.context.scanSkip.every((entry, index) => entry === row.context.scanSkip[index])))
  for (const row of result.rows) {
    const site = production.capabilities.find(candidate =>
      candidate.parser === row.parser
      && candidate.context.trivia === row.context.trivia
      && candidate.context.trackLines === row.context.trackLines
      && candidate.context.captureTrivia === row.context.captureTrivia
      && candidate.context.opaqueRootCapture === row.context.rootCapture
      && candidate.context.dynamicState === row.context.dynamicState
      && candidate.context.scanSkip.length === row.context.scanSkip.length
      && candidate.context.scanSkip.every((entry, index) => entry === row.context.scanSkip[index]))
    assert(site !== undefined)
    const expectedPolicies = rawScanConsumers(
      row.parser, row.context, name => grammar.rules[name], isSeparateOccurrence,
    )
    const actualPolicies = site.scanConsumerPolicyIds.map(id => {
      const policy = production.scanConsumerPolicies[id]
      assert(policy !== undefined)
      const ownSkip = policy.ownSkipPlanId === undefined
        ? undefined : production.ownSkipPlans[policy.ownSkipPlanId]
      const snapshot = production.contextSnapshots[policy.contextSnapshotId]
      assert(snapshot !== undefined)
      assert(policy.lookup === 'dynamic-parse-property-every-skip-test')
      assert(policy.pendingReuse === 'forbidden')
      if (policy.kind === 'scanTo') {
        assert.equal(policy.context, 'detached-per-attempt-state-errors-only')
        assert.equal(policy.ambient, policy.raw
          ? 'none-raw' : 'enumerate-trivia-then-scanSkip-per-parse-attempt')
      } else {
        assert.equal(policy.context, 'token-cleared-original')
        assert.equal(policy.ambient, policy.raw ? 'none-raw' : 'array-identity-interior-cache')
        assert.equal(policy.cache, 'lookup-every-attempt-enumerate-on-miss')
      }
      return {
        kind: policy.kind, raw: policy.raw, ownSkip: ownSkip?.entries.length ?? 0,
        hasTrivia: snapshot.hasTrivia, hasScanSkip: snapshot.hasScanSkip,
        trackLines: snapshot.trackLines, captureTrivia: snapshot.captureTrivia,
        rootCapture: snapshot.opaqueRootCapture, dynamicState: snapshot.dynamicState,
      }
    }).sort((a, b) => a.kind.localeCompare(b.kind) || Number(a.raw) - Number(b.raw) || a.ownSkip - b.ownSkip)
    assert.deepEqual(actualPolicies, expectedPolicies.map(policy => ({
      kind: policy.kind, raw: policy.raw, ownSkip: policy.ownSkip.length,
      hasTrivia: policy.context.trivia !== undefined,
      hasScanSkip: policy.context.scanSkip.length > 0,
      trackLines: policy.context.trackLines,
      captureTrivia: policy.context.captureTrivia,
      rootCapture: policy.context.rootCapture,
      dynamicState: policy.context.dynamicState,
    })), `${dialect} scanner ownership ${row.atom} ${row.path}`)
  }
  const tokenSites = production.capabilities.filter(site =>
    site.atom === 'token' && site.diagnosticPlanId !== undefined)
  assert(production.transitionDiagnostics.length <= tokenSites.length)
  for (const site of tokenSites) {
    const plan = production.transitionDiagnostics[site.diagnosticPlanId!]
    assert(plan !== undefined)
    assert(plan.events.every(event => event.state >= 0 && event.state < plan.stateCount))
  }
  const pointerFree = (value: unknown): boolean => {
    if (typeof value === 'function') return false
    if (value === null || typeof value !== 'object') return true
    if (value instanceof Map || value instanceof Set) return false
    return Object.values(value).every(pointerFree)
  }
  assert(production.transitionDiagnostics.every(pointerFree))
  assert(production.contextSnapshots.every(pointerFree))
  assert(production.ownSkipPlans.every(pointerFree))
  assert(production.scanConsumerPolicies.every(pointerFree))
  assert.equal(production.contextSnapshots.length, expected.contextSnapshots)
  assert.equal(production.ownSkipPlans.length, expected.ownSkipPlans)
  assert.equal(production.scanConsumerPolicies.length, expected.scanConsumers)
  assert.equal(production.bindingEdges.length, expected.bindingEdges)
  assert.equal(production.decisions.filter(site => site.pendingReuse === 'forbidden').length,
    expected.pendingForbidden)
  const eventHistogram: Record<string, number> = {}
  let states = 0
  let expectedSets = 0
  let expectedStrings = 0
  let balancedPlans = 0
  let balancedStates = 0
  let otherStates = 0
  for (const plan of production.transitionDiagnostics) {
    states += plan.stateCount
    const sites = tokenSites.filter(site => site.diagnosticPlanId === plan.id)
    if (sites.some(site => site.semanticKey.includes('"kind":"balanced"'))) {
      balancedPlans++
      balancedStates += plan.stateCount
    } else otherStates += plan.stateCount
    expectedSets += plan.expected.length
    expectedStrings += plan.expected.reduce((sum, set) => sum + set.length, 0)
    for (const event of plan.events) eventHistogram[event.op] = (eventHistogram[event.op] ?? 0) + 1
  }
  if (process.env.PM_CAPABILITY_ORACLE_PLANT === 'omit-diagnostic-event') {
    const [first, ...rest] = production.transitionDiagnostics
    assert(first !== undefined && first.events.length > 0)
    assertLexicalCapabilityClosure(roots.map(([, parser]) => parser), {
      ...production,
      transitionDiagnostics: [{ ...first, events: first.events.slice(1) }, ...rest],
    }, name => grammar.rules[name])
  }
  if (process.env.PM_CAPABILITY_ORACLE_PLANT === 'omit-scan-policy') {
    assert(production.scanConsumerPolicies.length > 0)
    assertLexicalCapabilityClosure(roots.map(([, parser]) => parser), {
      ...production, scanConsumerPolicies: production.scanConsumerPolicies.slice(1),
    }, name => grammar.rules[name])
  }
  if (process.env.PM_CAPABILITY_ORACLE_PLANT === 'mutate-static-context') {
    const [first, ...rest] = production.contextSnapshots
    assert(first !== undefined)
    assertLexicalCapabilityClosure(roots.map(([, parser]) => parser), {
      ...production,
      contextSnapshots: [{ ...first, hasScanSkip: !first.hasScanSkip }, ...rest],
    }, name => grammar.rules[name])
  }
  console.log(JSON.stringify({ dialect, occurrences: result.rows.length, counts: expected.counts,
    contexts: expected.contexts, digest, bindingEdges: result.bindingEdges,
    capabilityBindingEdges: production.bindingEdges.length,
    staticContexts: production.contextSnapshots.length,
    scanConsumers: production.scanConsumerPolicies.length,
    scanKinds: expected.scanKinds, scanDigest,
    ownSkipPlans: production.ownSkipPlans.length,
    pendingForbidden: expected.pendingForbidden,
    decisions: decisionFacts.decisions, finalExclusive: decisionFacts.finalExclusive,
    routedRoutes: decisionFacts.routedRoutes, decisionDigest: decisionFacts.digest,
    tokenOccurrences: tokenSites.length, diagnosticPlans: production.transitionDiagnostics.length,
    states, expectedSets, expectedStrings,
    balancedPlans, balancedStates, otherStates, eventHistogram, tableProgramWords: 0 }))
}
console.log(JSON.stringify({
  parseman: realpathSync(process.cwd()),
  parsemanSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  jess: realpathSync(JESS_ROOT),
  jessSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: JESS_ROOT, encoding: 'utf8' }).trim(),
  loader,
  node: process.version,
}))
