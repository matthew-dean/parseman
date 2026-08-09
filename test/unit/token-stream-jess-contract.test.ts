import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  cstBuildHost, gate, literal, run, rules, sequence,
  type Combinator, type ParseContext, type ParseResult,
} from '../../src/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { tableRules, type RunCfg } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { encodeTable, type TableSettings } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { foldPrograms, resolveTable, unfoldVariant, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import {
  JESS_TOKEN_CASES, JESS_TOKEN_FAMILIES, JESS_TOKEN_OUTCOMES, JESS_TOKEN_SITES,
  JESS_FUNCTION_STATEMENT_PREDECISIONS, compatibleOutcomeIds, jessTokenContractGrammar,
  outcomeById, predecideTokenChoice, predicateMatches, selectedRoute,
  type TokenPredecisionContract, type TokenSiteContract,
} from '../helpers/token-stream-jess-contract.ts'

type Entry = Combinator<unknown> | ((input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>)
type RuleMap = Record<string, Entry>
const STRICT: RunCfg = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
const DIR = path.dirname(fileURLToPath(import.meta.url))
const TABLE_RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/index.ts')).href

function program(grammar: Record<string, Combinator<unknown>>, settings: TableSettings = {}): TableProgram {
  return encodeTable(grammar, settings)
}

function precompiled(prog: TableProgram, cfg: RunCfg = STRICT): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, cfg)
  const factory = new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory']
  return { ...prog, asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }] }
}

async function emittedModule(prog: TableProgram, tag: string): Promise<RuleMap> {
  const src = emitTableModule(prog, {
    name: 'grammar', runtime: TABLE_RUNTIME, runtimeRef: 'tableRules',
    fnSources: prog.fns.map(fn => String(fn)),
  })
  const dir = mkdtempSync(path.join(tmpdir(), `pm-token-contract-${tag}-`))
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const file = path.join(dir, 'grammar.ts')
  writeFileSync(file, src)
  const mod = await import(/* @vite-ignore */ pathToFileURL(file).href) as { grammar: RuleMap }
  return mod.grammar
}

function maps(grammar: Record<string, Combinator<unknown>>, prog: TableProgram): Record<string, RuleMap> {
  return {
    source: grammar,
    reference: execRules(prog) as RuleMap,
    closure: tableRules({ ...prog, asm: [] }) as RuleMap,
    emitted: tableRules(prog) as RuleMap,
    precompiled: tableRules(precompiled(prog)) as RuleMap,
  }
}

function direct(entry: Entry, input: string, build?: ParseContext['build']): ParseResult<unknown> {
  const ctx = createParseContext()
  ctx.build = build
  if (typeof entry !== 'function') {
    ctx.trivia = entry._meta.grammarTrivia
    ctx.triviaKindLabels = entry._meta.grammarTrivia?._meta.triviaKindLabels
    return entry.parse(input, 0, ctx)
  }
  return entry(input, 0, ctx)
}

function coreDigest(result: ParseResult<unknown>): string {
  return digestValue({
    ok: result.ok,
    value: result.ok ? result.value : undefined,
    span: result.span,
    expected: result.ok ? undefined : result.expected,
    committed: result.ok ? undefined : result.committed,
  })
}

function coreDigestWithoutLineFields(result: ParseResult<unknown>): string {
  return digestValue({
    ok: result.ok,
    value: result.ok ? result.value : undefined,
    span: { start: result.span.start, end: result.span.end },
    expected: result.ok ? undefined : result.expected,
    committed: result.ok ? undefined : result.committed,
  })
}

function fullDigest(entry: Entry, input: string, opts: Parameters<typeof run>[2] = {}): string {
  const result = run(entry as Parameters<typeof run>[0], input, opts)
  return digestValue({
    ok: result.ok, value: result.value, span: result.span, expected: result.expected,
    errors: result.errors, unconsumedFrom: result.unconsumedFrom,
    rootTrivia: result.rootTrivia === undefined ? undefined : {
      rows: result.rootTrivia.rows, select: result.rootTrivia.select,
    },
  })
}

function probeExpected(entry: Entry, input: string, offset: number): readonly string[] {
  const ctx = createParseContext()
  ctx._probe = { offset, best: null }
  if (typeof entry !== 'function') {
    ctx.trivia = entry._meta.grammarTrivia
    ctx.triviaKindLabels = entry._meta.grammarTrivia?._meta.triviaKindLabels
    entry.parse(input.slice(0, offset), 0, ctx)
  } else {
    entry(input.slice(0, offset), 0, ctx)
  }
  return ctx._probe.best?.expected ?? []
}

function expectDirectIdentity(all: Record<string, RuleMap>, rule: string, input: string, build?: ParseContext['build']): void {
  const authority = coreDigest(direct(all.source![rule]!, input, build))
  for (const [engine, grammar] of Object.entries(all)) {
    expect(coreDigest(direct(grammar[rule]!, input, build)), `${engine} ${rule} ${JSON.stringify(input)}`).toBe(authority)
  }
}

describe('real-Jess token stream: global identity and site-local routes', () => {
  it('keeps family, outcome, compatible-view and ordered-route identity separate', () => {
    expect(new Set(Object.values(JESS_TOKEN_FAMILIES).map(entry => entry.id)).size)
      .toBe(Object.keys(JESS_TOKEN_FAMILIES).length)
    expect(new Set(JESS_TOKEN_OUTCOMES.map(entry => entry.id)).size).toBe(JESS_TOKEN_OUTCOMES.length)
    for (const site of JESS_TOKEN_SITES) {
      for (const id of site.outcomes) expect(outcomeById(id).family, `${site.id}: ${id}`).toBe(site.family)
      for (const siteRoute of site.routes) {
        expect(siteRoute.accepted.length, `${site.id}: route ${siteRoute.index}`).toBeGreaterThan(0)
        for (const id of siteRoute.accepted) expect(site.outcomes, `${site.id}: ${id}`).toContain(id)
      }
    }

    const cssValue = JESS_TOKEN_SITES.find(site => site.id === 'css.Value')!
    const cssHeader = JESS_TOKEN_SITES.find(site => site.id === 'css.TypedValue/Header')!
    const lessValue = JESS_TOKEN_SITES.find(site => site.id === 'less.Value')!
    const statement = JESS_TOKEN_SITES.find(site => site.id === 'less.FunctionStatement')!

    // One global URL identity is reusable across differently grouped local sites;
    // their fallback identities are not equivalent exclusion partitions.
    expect(cssValue.family).toBe(cssHeader.family)
    expect(cssValue.outcomes).toContain('css:url-open')
    expect(cssHeader.outcomes).toContain('css:url-open')
    expect(outcomeById('css:value-ident').id).not.toBe(outcomeById('css:header-ident').id)

    // Exact values retain broader compatible views. Selection is still first
    // matching PEG route, so the exact route owns the continuation and cut.
    expect(compatibleOutcomeIds(cssValue, 'URL(')).toEqual(['css:url-open', 'css:function-open'])
    expect(selectedRoute(cssValue, 'URL(')?.continuation).toBe('UrlFunction')
    expect(compatibleOutcomeIds(lessValue, 'EaCh(')).toEqual(['less:function-open'])
    expect(compatibleOutcomeIds(statement, 'EaCh(')).toEqual(['less:each-open', 'less:statement-function-open'])
    expect(selectedRoute(statement, 'EaCh(')?.continuation).toBe('EachFunctionStatement')
    expect(selectedRoute(statement, 'ordinary(')?.continuation).toBe('GenericFunctionStatement')
    expect(selectedRoute(statement, 'url(')).toBeUndefined()
    expect(selectedRoute(statement, 'calc(')).toBeUndefined()
    expect(selectedRoute(statement, 'bare')).toBeUndefined()

    // CSS escaped identifiers and Less interpolation prefixes are different
    // recognizer languages even when the common ASCII subset has equal spans.
    expect(cssValue.family).not.toBe(lessValue.family)
    expect(JESS_TOKEN_FAMILIES.cssIdentOrFunction.refusesSharingWith).toContain(lessValue.family)
    expect(predicateMatches(outcomeById('numeric:number').predicate, '-.5')).toBe(true)
    expect(predicateMatches(outcomeById('numeric:dimension').predicate, '10px')).toBe(true)
    expect(predicateMatches(outcomeById('numeric:percentage').predicate, '10%')).toBe(true)
  })

  it('has a test-local RED plant for atomic outcomes versus ordered routes', () => {
    const site = JESS_TOKEN_SITES.find(entry => entry.id === 'less.FunctionStatement')!
    const planted: TokenSiteContract = {
      ...site,
      routes: [site.routes[1]!, site.routes[0]!],
    }
    expect(selectedRoute(site, 'each(')?.continuation).toBe('EachFunctionStatement')
    expect(selectedRoute(planted, 'each(')?.continuation).toBe('GenericFunctionStatement')
    expect(selectedRoute(planted, 'each(')).not.toEqual(selectedRoute(site, 'each('))
  })
})

describe('real-Jess token stream: sparse outer-choice predecision', () => {
  const statement = JESS_TOKEN_SITES.find(site => site.id === 'less.FunctionStatement')!

  it('pins the four corrected-Jess sites without a universal choice structure', () => {
    expect(JESS_FUNCTION_STATEMENT_PREDECISIONS).toEqual([
      { choice: 'less.blockItem', armIndex: 2, dispatchSite: statement.id, noRouteExpected: ['"each("'] },
      { choice: 'less.BodyStatement', armIndex: 4, dispatchSite: statement.id, noRouteExpected: ['"each("'] },
      { choice: 'less.KeyframeBlock.item', armIndex: 1, dispatchSite: statement.id, noRouteExpected: ['"each("'] },
      { choice: 'less.Stylesheet.item', armIndex: 2, dispatchSite: statement.id, noRouteExpected: ['"each("'] },
    ])
    expect(new Set(JESS_FUNCTION_STATEMENT_PREDECISIONS.map(row => row.dispatchSite))).toEqual(new Set([statement.id]))
  })

  it('enters compatible routes, skips proven no-route ranges, and defers recognizer misses', () => {
    const relation = JESS_FUNCTION_STATEMENT_PREDECISIONS[0]!
    const input = {}
    const decide = (value: string) => predecideTokenChoice(
      relation, statement, { input, start: 17, end: 17 + value.length, value },
    )

    const each = decide('EaCh(')
    expect(each).toMatchObject({ kind: 'enter', route: { index: 0, continuation: 'EachFunctionStatement' } })
    if (each.kind !== 'enter') throw new Error('each must enter')
    expect(each.pending).toMatchObject({ input, start: 17, end: 22, family: statement.family })
    expect(each.pending.compatible).toEqual(['less:each-open', 'less:statement-function-open'])

    expect(decide('ordinary(')).toMatchObject({
      kind: 'enter', route: { index: 1, continuation: 'GenericFunctionStatement' },
    })
    for (const value of ['url(', 'calc(', 'bare']) {
      expect(decide(value), value).toMatchObject({
        kind: 'skip', expected: ['"each("'],
        pending: { input, start: 17, end: 17 + value.length, family: statement.family },
      })
    }
    expect(predecideTokenChoice(relation, statement, undefined)).toEqual({ kind: 'defer' })
  })

  it('keeps the no-route expectation at the skipped arm position and the range reusable', () => {
    const input = {}
    const relation = JESS_FUNCTION_STATEMENT_PREDECISIONS[1]!
    const result = predecideTokenChoice(relation, statement, {
      input, start: 4, end: 8, value: 'url(',
    })
    expect(result.kind).toBe('skip')
    if (result.kind !== 'skip') throw new Error('url( must be a no-route range')

    const expectedByPegOrder = ['"@"', ...result.expected, 'ruleset', 'declaration', '";"']
    expect(expectedByPegOrder).toEqual(['"@"', '"each("', 'ruleset', 'declaration', '";"'])
    expect(result.pending).toMatchObject({ input, start: 4, end: 8, family: statement.family })
    const valueSite = JESS_TOKEN_SITES.find(site => site.id === 'less.Value')!
    expect(valueSite.family).toBe(result.pending.family)
    expect(selectedRoute(valueSite, 'url(')?.continuation).toBe('URL')
  })

  it('has RED teeth for an arm/site relation mutation', () => {
    const relation = JESS_FUNCTION_STATEMENT_PREDECISIONS[0]!
    const wrongSite: TokenPredecisionContract = { ...relation, dispatchSite: 'less.Value' }
    expect(() => predecideTokenChoice(wrongSite, statement, {
      input: {}, start: 0, end: 5, value: 'each(',
    })).toThrow('predecision dispatch-site mismatch')

    const planted = JESS_FUNCTION_STATEMENT_PREDECISIONS.map((row, index) =>
      index === 0 ? { ...row, armIndex: row.armIndex + 1 } : row)
    expect(planted).not.toEqual(JESS_FUNCTION_STATEMENT_PREDECISIONS)
  })
})

describe('real-Jess token stream: authored source is the semantic authority', () => {
  it('matches direct .parse in reference, closure, emitted and precompiled assemblies', () => {
    const grammar = jessTokenContractGrammar() as Record<string, Combinator<unknown>>
    const prog = program(grammar)
    const all = maps(grammar, prog)
    for (const [rule, inputs] of Object.entries(JESS_TOKEN_CASES)) {
      for (const input of inputs) expectDirectIdentity(all, rule, input)
    }
  })

  it('preserves exact-route commitment, grouped keys, duplicate routes and no-route diagnostics', () => {
    const grammar = jessTokenContractGrammar() as Record<string, Combinator<unknown>>
    const prog = program(grammar)
    const all = maps(grammar, prog)

    for (const grammarMap of Object.values(all)) {
      expect(direct(grammarMap.CssValue!, 'URL(:x')).toMatchObject({ ok: true, value: ['URL(', ['URL(', ':x']] })
      expect(direct(grammarMap.CssValue!, 'URL(:f')).toMatchObject({ ok: false, committed: true })
      expect(direct(grammarMap.FunctionStatement!, 'each(:e')).toMatchObject({ ok: true })
      expect(direct(grammarMap.FunctionStatement!, 'each(:s')).toMatchObject({ ok: false, committed: true })
      for (const input of ['url(', 'calc(', 'bare']) {
        expect(direct(grammarMap.FunctionStatement!, input), input).toMatchObject({ ok: false })
      }
      expect(direct(grammarMap.DuplicateRoutes!, 'ordinary(:d')).toMatchObject({ ok: true })
      expect(direct(grammarMap.DuplicateRoutes!, 'ordinary(:z')).toMatchObject({ ok: false, committed: true })
      expect(direct(grammarMap.ReusedParserRoutes!, 'alpha:d')).toMatchObject({ ok: true })
      expect(direct(grammarMap.ReusedParserRoutes!, 'beta:d')).toMatchObject({ ok: true })
    }
  })

  it('preserves no-route end/CST rollback before a later same-family consumer', async () => {
    const grammar = jessTokenContractGrammar('cst') as Record<string, Combinator<unknown>>
    const prog = program(grammar, { hostMode: 'cst' })
    const all = maps(grammar, prog)
    all.module = await emittedModule(prog, 'no-route')
    const opts = { build: cstBuildHost({ tags: true }) }

    const source = fullDigest(grammar.StatementOrValue!, 'url(:u', opts)
    for (const [engine, map] of Object.entries(all)) {
      expect(fullDigest(map.StatementOrValue!, 'url(:u', opts), engine).toBe(source)
    }

    const failed = direct(grammar.FunctionStatement!, 'url(')
    expect(failed).toMatchObject({ ok: false, span: { start: 4, end: 4 }, expected: ['"each("'] })
    expect(failed).not.toHaveProperty('committed', true)

    const parsed = run(grammar.StatementOrValue!, 'url(:u', opts)
    expect(parsed).toMatchObject({ ok: true, span: { start: 0, end: 6 }, unconsumedFrom: null })
    expect(JSON.stringify(parsed.value).match(/url\(/g)).toHaveLength(1)
  })

  it('preserves numeric maximal range boundaries and refuses trivia inside a range', () => {
    const grammar = jessTokenContractGrammar() as Record<string, Combinator<unknown>>
    const all = maps(grammar, program(grammar))
    for (const grammarMap of Object.values(all)) {
      expect(direct(grammarMap.NumericValue!, '10%')).toMatchObject({ ok: true, span: { start: 0, end: 3 } })
      expect(direct(grammarMap.NumericValue!, '10px')).toMatchObject({ ok: true, span: { start: 0, end: 4 } })
      expect(direct(grammarMap.NumericValue!, '10')).toMatchObject({ ok: true, span: { start: 0, end: 2 } })
      expect(direct(grammarMap.LessPercentage!, '10 %')).toMatchObject({ ok: false })
      expect(direct(grammarMap.CssDimension!, '10 %')).toMatchObject({ ok: true, span: { start: 0, end: 2 } })
    }
  })

  it('has a semantic RED plant that changes the each route and is caught by direct identity', () => {
    const grammar = jessTokenContractGrammar() as Record<string, Combinator<unknown>>
    const prog = program(grammar)
    const index = prog.dsp.findIndex(spec => spec.fold.includes('each('))
    expect(index).toBeGreaterThanOrEqual(0)
    const original = prog.dsp[index]!
    const eachAt = original.fold.indexOf('each(')
    expect(eachAt).toBeGreaterThanOrEqual(0)
    expect(original.match).toHaveLength(1)
    const plantedSpec = { ...original, foldArm: [...original.foldArm] }
    plantedSpec.foldArm[eachAt] = original.match[0]![3]
    const planted = { ...prog, asm: [], dsp: prog.dsp.map((spec, i) => i === index ? plantedSpec : spec) }
    const authority = coreDigest(direct(grammar.FunctionStatement!, 'each(:e'))
    expect(coreDigest(direct(tableRules(planted).FunctionStatement! as Entry, 'each(:e'))).not.toBe(authority)
  })
})

describe('real-Jess token stream: product artifact and cold-mode contract', () => {
  it('round-trips a real module and remains CSP-safe after import', async () => {
    const grammar = jessTokenContractGrammar() as Record<string, Combinator<unknown>>
    const prog = program(grammar)
    const all = maps(grammar, prog)
    all.module = await emittedModule(prog, 'ast')

    for (const [rule, inputs] of Object.entries(JESS_TOKEN_CASES)) {
      for (const input of inputs) expectDirectIdentity(all, rule, input)
    }

    const NativeFunction = globalThis.Function
    globalThis.Function = function forbidden(): never {
      throw new Error('runtime Function constructor used')
    } as unknown as FunctionConstructor
    try {
      for (const map of [all.precompiled!, all.module!]) {
        expect(fullDigest(map.FunctionStatement!, 'each(:e')).toBe(fullDigest(grammar.FunctionStatement!, 'each(:e'))
        expect(fullDigest(map.CssValue!, '\\66 oo(:f')).toBe(fullDigest(grammar.CssValue!, '\\66 oo(:f'))
      }
    } finally {
      globalThis.Function = NativeFunction
    }
  })

  it('preserves CST leaves/raw children, ambient trivia and selected root comments', async () => {
    const grammar = jessTokenContractGrammar('cst') as Record<string, Combinator<unknown>>
    const prog = program(grammar, { hostMode: 'cst' })
    const all = maps(grammar, prog)
    all.module = await emittedModule(prog, 'cst')
    const opts = { build: cstBuildHost({ tags: true }), rootTrivia: { select: ['blockComment'] as const } }
    const input = '[ /*a*/ url(:x /*b*/ ]'
    const source = fullDigest(grammar.TokenNode!, input, opts)
    for (const [engine, map] of Object.entries(all)) {
      expect(fullDigest(map.TokenNode!, input, opts), engine).toBe(source)
    }
    expect(run(grammar.TokenNode!, input, opts).rootTrivia?.rows.length).toBeGreaterThan(0)

    const ast = jessTokenContractGrammar() as Record<string, Combinator<unknown>>
    const value = run(ast.TokenNode!, input).value as { children: unknown[]; rawChildren: unknown[] }
    expect(value.children.length).toBeGreaterThan(0)
    expect(value.rawChildren.length).toBeGreaterThan(0)
  })

  it('keeps tolerant, completion-probe, coverage and tracked paths on source semantics', () => {
    const grammar = jessTokenContractGrammar() as Record<string, Combinator<unknown>>
    const prog = program(grammar)
    const all = maps(grammar, prog)
    for (const input of ['ordinary:x', 'ordinary(', 'url(', 'each(:s']) {
      const source = fullDigest(grammar.FunctionStatement!, input, { tolerant: true })
      for (const [engine, map] of Object.entries(all)) {
        expect(fullDigest(map.FunctionStatement!, input, { tolerant: true }), `${engine} tolerant ${input}`).toBe(source)
      }
      const sourceCompletions = probeExpected(grammar.FunctionStatement!, input, input.length)
      for (const [engine, map] of Object.entries(all)) {
        expect(probeExpected(map.FunctionStatement!, input, input.length), `${engine} probe ${input}`).toEqual(sourceCompletions)
      }
    }

    const hits = (entry: Entry): string[] => {
      const out: string[] = []
      run(entry as Parameters<typeof run>[0], 'ordinary(:s', {
        instrumentation: { _grammarCoverage: id => out.push(id) },
      })
      return out
    }
    const sourceHits = hits(grammar.FunctionStatement!)
    for (const map of Object.values(all)) expect(hits(map.FunctionStatement!)).toEqual(sourceHits)

    const tracked = program(grammar, { trackLines: true })
    const trackedMaps = maps(grammar, tracked)
    for (const input of ['ordinary(:s', 'ordinary\n(:s']) {
      const authority = coreDigestWithoutLineFields(direct(grammar.FunctionStatement!, input))
      for (const [engine, map] of Object.entries(trackedMaps)) {
        expect(coreDigestWithoutLineFields(direct(map.FunctionStatement!, input)), `${engine} tracked`).toBe(authority)
      }
    }
  })

  it('folds plain/tracked artifacts without sharing a variant decision path', () => {
    const grammar = jessTokenContractGrammar() as Record<string, Combinator<unknown>>
    const plain = program(grammar)
    const tracked = program(grammar, { trackLines: true })
    const folded = foldPrograms({ plain, tracked }, 'plain')
    for (const name of ['plain', 'tracked'] as const) {
      const directMap = execRules(name === 'plain' ? plain : tracked) as RuleMap
      const foldedMap = tableRules(unfoldVariant(folded, name)) as RuleMap
      for (const input of ['each(:e', 'ordinary(:s', 'url(', '\\66 oo(:f']) {
        expect(fullDigest(foldedMap.FunctionStatement!, input), `${name} ${input}`)
          .toBe(fullDigest(directMap.FunctionStatement!, input))
      }
    }
  })

  it('restores parse-local token state across same-assembly reentry', () => {
    type State = { inner: Entry }
    const build = () => {
      const base = jessTokenContractGrammar() as Record<string, Combinator<unknown>>
      return rules(g => ({
        Inner: base.LessValue!,
        Outer: sequence(
          gate(state => {
            const inner = (state as State).inner
            return typeof inner === 'function'
              ? run(inner as Parameters<typeof run>[0], 'beta(:f').ok
              : inner.parse('beta(:f', 0, createParseContext()).ok
          }),
          g.Inner,
          literal('!'),
        ),
      })) as Record<string, Combinator<unknown>>
    }
    const source = build()
    const prog = program(source)
    const all: Record<string, RuleMap> = {
      source,
      reference: execRules(prog) as RuleMap,
      closure: tableRules({ ...prog, asm: [] }) as RuleMap,
      emitted: tableRules(prog) as RuleMap,
    }
    for (const [engine, map] of Object.entries(all)) {
      const result = run(map.Outer!, 'alpha(:f!', { state: { inner: map.Inner! } satisfies State })
      expect(result, engine).toMatchObject({ ok: true, unconsumedFrom: null })
      expect(result.value, engine).toEqual([null, ['alpha(', ['alpha(', ':f']], '!'])
    }
  })
})
