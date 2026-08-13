import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  classifiedTrivia, completionsAt, cstBuildHost, dispatch, endsWith, label, literal,
  makeWhen, matches, node, otherwise, parser, regex, routed, run, sequence,
  startsWith, token, transform, trivia, when, type Combinator, type ParseContext,
} from '../../src/index.ts'
import { buildGrammarPlan } from '../../src/compiler/grammar-coverage-ids.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { defaultAssemblyCfgs, emitFoldedModule, emitTableModule } from '../../src/table/emit.ts'
import { encodeTable, type TableSettings } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_DISPATCH } from '../../src/table/ops.ts'
import {
  foldPrograms, ownTableProgram, resolveTable, unfoldVariant,
  type PrecompiledAssembly, type TableProgram,
} from '../../src/table/program.ts'

type Entry = Parameters<typeof run>[0]
const DIR = path.dirname(fileURLToPath(import.meta.url))
const TABLE_RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/index.ts')).href
const FOLD_RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/fold.ts')).href
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
const CLOSURE_CFG = { ...STRICT, hostReadsChildren: true }

function program(entry: Combinator<unknown>, settings: TableSettings = {}): TableProgram {
  return encodeTable({ Entry: entry }, settings)
}

function dispatchIp(prog: TableProgram): number {
  const ips = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_DISPATCH)
  expect(ips).toHaveLength(1)
  return ips[0]!
}

function projection(entry: Entry, input: string, opts: Parameters<typeof run>[2] = {}): unknown {
  const result = run(entry, input, opts)
  return {
    ok: result.ok,
    value: result.value,
    span: result.span,
    expected: result.expected,
    errors: result.errors,
    committed: (result as { committed?: boolean }).committed,
    unconsumedFrom: result.unconsumedFrom,
    rootTrivia: result.rootTrivia === undefined ? undefined : {
      rows: [...result.rootTrivia.rows],
      select: [...result.rootTrivia.select],
      text: Array.from(
        { length: result.rootTrivia.index.entries.length },
        (_, i) => result.rootTrivia!.index.entries.text(i, input),
      ),
    },
  }
}

function precompiled(prog: TableProgram, mutate: (source: string) => string = source => source): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(...EMITTED_PARAMS, mutate(emitted.source)) as PrecompiledAssembly['factory']
  return ownTableProgram({
    ...prog,
    asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }],
  })
}

function engines(grammar: Combinator<unknown>, prog = program(grammar)): Record<string, Entry> {
  return {
    source: grammar as Entry,
    reference: execRules(prog).Entry! as Entry,
    closure: tableRules({ ...prog, asm: [] }).Entry! as Entry,
    emitted: tableRules(prog).Entry! as Entry,
    precompiled: tableRules(precompiled(prog)).Entry! as Entry,
  }
}

function expectIdentity(entries: Record<string, Entry>, inputs: readonly string[], opts: Parameters<typeof run>[2] = {}): void {
  for (const input of inputs) {
    const expected = projection(entries.source!, input, opts)
    for (const [name, entry] of Object.entries(entries)) {
      expect(projection(entry, input, opts), `${name}: ${JSON.stringify(input)}`).toEqual(expected)
    }
  }
}

async function loadModule(prog: TableProgram): Promise<Record<string, Entry>> {
  const source = emitTableModule(prog, {
    name: 'grammar', runtime: TABLE_RUNTIME, runtimeRef: 'tableRules',
    fnSources: prog.fns.map(fn => String(fn)), assemblies: defaultAssemblyCfgs(prog),
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-dispatch-direct-'))
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const file = path.join(dir, 'grammar.ts')
  writeFileSync(file, source)
  return (await import(/* @vite-ignore */ pathToFileURL(file).href) as {
    grammar: Record<string, Entry>
  }).grammar
}

function blockFunctionConstructor<T>(body: () => T): T {
  const real = globalThis.Function
  globalThis.Function = new Proxy(real, {
    construct(): object { throw new Error('Function constructor reached after module import') },
    apply(): unknown { throw new Error('Function constructor reached after module import') },
  })
  try { return body() } finally { globalThis.Function = real }
}

/** Mixed routed/plain arms, exact/fold/matcher/fallback, and >4 matchers. */
function matrix(): Combinator<unknown> {
  const ci = makeWhen({ caseInsensitive: true })
  return dispatch(
    token(regex(/[A-Za-z-]+\(?/)),
    when('exact', sequence(routed(), literal('!'))),
    ci('fold', literal('?')),
    when(startsWith('pre'), sequence(routed(), literal(':'))),
    when(endsWith('('), sequence(routed(), literal(')'))),
    when(matches(/^dash-/), literal(';')),
    when(startsWith('never-a'), literal('0')),
    when(endsWith('never-b'), literal('1')),
    when(matches(/^global/), literal('+')),
    otherwise(sequence(routed(), literal('.'))),
  )
}

describe('direct-bound dispatch topology', () => {
  it('binds fixed arms, routed flags and matcher predicates without parse-time arrays', () => {
    const grammar = matrix()
    const prog = program(grammar)
    const ip = dispatchIp(prog)
    const table = resolveTable(prog)
    const spec = table.dsp[prog.code[ip + 2]!]!
    expect(spec.match.length).toBeGreaterThan(4)

    const emitted = emitAssemblySource(table, prog, STRICT)
    expect(emitted.source).not.toMatch(/\.routed\b|\brouted\[|\bmatchFn\[|\bmatchArm\[|\barms\[/)
    expect(emitted.source).toMatch(/switch\(arm\)/)
    expect(emitted.source).toMatch(/case 0:\{const savedRouted=ctx\._routed/)
    expect(emitted.source).toMatch(/case 1:v=\w+\(input,selEnd,ctx\);break/)
    expect(emitted.plan).toEqual({ classes: [], armExpected: [], masks: [] })

    const closureBody = assemble(table, { ...prog, asm: [] }, CLOSURE_CFG).pieces.Entry!.toString()
    expect(closureBody).toContain('classify(key)')
    expect(closureBody).toContain('runArm(arm')
    expect(closureBody).not.toMatch(/arms\[|routed\[|matchFn\[|matchArm\[|target\(/)

    const source = readFileSync(path.resolve(DIR, '../../src/table/assemble.ts'), 'utf8')
    const dispatchCase = source.slice(source.indexOf('case OP_DISPATCH:'), source.indexOf('/* ── node'))
    expect(dispatchCase).not.toMatch(/const arms:|const matchFn:|const matchArm:|const routed = spec\.routed[\s\S]*routed\[arm\]/)
    const matcherBlock = source.slice(
      source.indexOf('function dispatchMatcherBlock('), source.indexOf('function dispatchBranch('),
    )
    expect(matcherBlock).toMatch(/m0\(key\)/)
    expect(matcherBlock).toMatch(/m3\(key\)/)
    expect(matcherBlock).not.toMatch(/matchFn\[|matchArm\[/)
    const armBlock = source.slice(
      source.indexOf('function dispatchArmBlock('), source.indexOf('function trackLinesInto('),
    )
    expect(armBlock).toMatch(/a0\(input, pos, selEnd, key, selectorMark, ctx\)/)
    expect(armBlock).toMatch(/a3\(input, pos, selEnd, key, selectorMark, ctx\)/)
    expect(armBlock).not.toMatch(/arms\[|routed\[|target\(/)

    const allRouted = dispatch(regex(/[a-z]+/), when('a', routed()), otherwise(routed()))
    const routedProg = program(allRouted)
    const routedSource = emitAssemblySource(resolveTable(routedProg), routedProg, STRICT).source
    expect(routedSource).toMatch(/case 0:\{const savedRouted=ctx\._routed/)
    expect(routedSource).toMatch(/default:\{const savedRouted=ctx\._routed/)
    const allPlain = dispatch(regex(/[a-z]+/), when('a', literal('!')), otherwise(literal('?')))
    const plainProg = program(allPlain)
    const plainSource = emitAssemblySource(resolveTable(plainProg), plainProg, STRICT).source
    expect(plainSource).toMatch(/case 0:v=\w+\(input,selEnd,ctx\);break/)
    expect(plainSource).not.toContain('const savedRouted=ctx._routed')
  })

  it('preserves exact, fold, matcher order, routed ownership, fallback and diagnostics', () => {
    const grammar = matrix()
    const entries = engines(grammar)
    expectIdentity(entries, [
      'exact!', 'FOLD?', 'prefix:', 'open()', 'dash-name;', 'global+',
      'other.', 'exact?', 'fold!', 'prefix!', 'unknown!', '',
    ])

    // Duplicate matcher predicates retain authored arm order even when they
    // point at distinct children. This is route identity, not predicate identity.
    const duplicate = dispatch(
      regex(/[a-z]+/),
      when(startsWith('a'), literal('1')),
      when(startsWith('a'), literal('2')),
      otherwise(literal('3')),
    )
    expectIdentity(engines(duplicate), ['abc1', 'abc2', 'z3', 'z1'])

    // Matcher predicates remain stable across repeated parses. Global/sticky
    // regexes are refused by the public matches() constructor before encoding.
    for (let i = 0; i < 3; i++) expectIdentity(entries, ['global+'])
    expect(() => matches(/^global/g)).toThrow(/global or sticky/)
    expect(() => matches(/^sticky/y)).toThrow(/global or sticky/)

    const noFallback = dispatch(regex(/[a-z]+/), when('yes', literal('!')))
    expectIdentity(engines(noFallback), ['yes!', 'no!', ''])
  })

  it('preserves CST/raw/classified trivia, cold modes, commitment and probe output', () => {
    const space = trivia(regex(/[ ]+/))
    const comments = classifiedTrivia({ blockComment: regex(/\/\*[^]*?\*\//), whitespace: regex(/[ ]+/) })
    const cstGrammar = parser(
      { trivia: comments },
      node('Root', dispatch(
        token(regex(/[a-z]+/)),
        when('exact', sequence(routed(), literal('!'))),
        otherwise(sequence(routed(), literal('?'))),
      )),
    )
    const opts = { build: cstBuildHost({ tags: true }), rootTrivia: { select: ['blockComment'] as const } }
    expectIdentity(engines(cstGrammar), [
      '/*root*/ exact /*inside*/ ! /*tail*/',
      '/*root*/ other /*inside*/ ? /*tail*/',
      '/*root*/ exact /*inside*/ ? /*tail*/',
    ], opts)

    const committed = dispatch(
      token(regex(/[a-z]+/)),
      when('exact', sequence(routed(), literal('!'))),
      otherwise(sequence(routed(), literal('?'))),
    )
    expectIdentity(engines(committed), ['exact?', 'other!', ''])

    const recoveryProg = program(committed, { recovery: true })
    expectIdentity(engines(committed, recoveryProg), ['exact!', 'exact?', 'other?', ''], { tolerant: true })
    const trackedProg = program(committed, { trackLines: true })
    const tracked = engines(committed, trackedProg)
    for (const input of ['exact!', 'exact?', 'other?', '']) {
      const expected = projection(tracked.reference!, input)
      for (const [name, entry] of Object.entries(tracked)) {
        if (name !== 'source') expect(projection(entry, input), name).toEqual(expected)
      }
    }

    const covered = label('dispatch-direct', parser({ trivia: space }, committed))
    const coveragePlan = buildGrammarPlan(covered)
    const coverageProg = program(covered, { coverage: coveragePlan })
    expectIdentity({
      source: covered as Entry,
      reference: execRules(coverageProg).Entry! as Entry,
      closure: tableRules({ ...coverageProg, asm: [] }).Entry! as Entry,
      emittedFallback: tableRules(coverageProg).Entry! as Entry,
    }, [' exact !', ' other ?', ' other !', ''])

    const closure = tableRules({ ...program(committed), asm: [] }).Entry! as Entry
    const closureProbe = {
      ...committed,
      parse: closure as Combinator<unknown>['parse'],
    }
    for (const [input, offset] of [['exact', 5], ['other', 5], ['', 0]] as const) {
      expect(completionsAt(closureProbe, input, offset).slice().sort())
        .toEqual(completionsAt(committed, input, offset).slice().sort())
    }
  })

  it('round-trips precompiled/folded modules under CSP and keeps nested frames isolated', async () => {
    const grammar = matrix()
    const prog = program(grammar)
    const loaded = await loadModule(prog)
    for (const input of ['exact!', 'FOLD?', 'prefix:', 'open()', 'dash-name;', 'other.', '']) {
      expect(blockFunctionConstructor(() => projection(loaded.Entry!, input)))
        .toEqual(projection(grammar as Entry, input))
    }

    const tracked = program(grammar, { trackLines: true })
    const folded = foldPrograms({ plain: prog, tracked }, 'plain')
    const source = emitFoldedModule(folded, {
      runtime: FOLD_RUNTIME,
      fnSources: folded.base.fns.map(fn => String(fn)),
      names: { plain: 'plainGrammar', tracked: 'trackedGrammar' },
    })
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-dispatch-fold-'))
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const file = path.join(dir, 'grammar.ts')
    writeFileSync(file, source)
    const modules = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
      plainGrammar: Record<string, Entry>
      trackedGrammar: Record<string, Entry>
    }
    for (const [name, direct] of Object.entries({ plain: prog, tracked })) {
      expect([...unfoldVariant(folded, name).code]).toEqual([...direct.code])
      for (const input of ['exact!', 'FOLD?', 'prefix:', 'other.', '']) {
        expect(projection(modules[`${name}Grammar` as keyof typeof modules].Entry!, input))
          .toEqual(projection(tableRules(direct).Entry! as Entry, input))
      }
    }

    const inner = matrix()
    const hook = '__parsemanDispatchDirectInner__'
    const reenter = node('Reenter', literal('a'), () => {
      const enter = (globalThis as unknown as { __parsemanDispatchDirectInner__: () => boolean })
        .__parsemanDispatchDirectInner__
      if (!enter()) throw new Error('nested dispatch did not consume')
      return 'nested'
    })
    const outer = dispatch(
      literal('a'),
      when('a', sequence(reenter, literal('!'))),
    )
    const nestedGrammar = { Inner: inner, Outer: outer }
    const nestedProg = encodeTable(nestedGrammar)
    const maps: Record<string, Record<string, Entry>> = {
      source: nestedGrammar as unknown as Record<string, Entry>,
      reference: execRules(nestedProg) as Record<string, Entry>,
      closure: tableRules({ ...nestedProg, asm: [] }) as Record<string, Entry>,
      emitted: tableRules(nestedProg) as Record<string, Entry>,
      precompiled: tableRules(precompiled(nestedProg)) as Record<string, Entry>,
      module: await loadModule(nestedProg),
    }
    const installInner = (entry: Entry): void => {
      ;(globalThis as unknown as Record<string, () => boolean>)[hook] = () => {
        const result = run(entry, 'prefix:')
        return result.ok && result.span.end === 7
      }
    }
    installInner(maps.source!.Inner!)
    const expected = projection(maps.source!.Outer!, 'aa!')
    for (const [name, map] of Object.entries(maps)) {
      installInner(map.Inner!)
      expect(projection(map.Outer!, 'aa!'), name).toEqual(expected)
    }
    ;(globalThis as unknown as Record<string, (() => boolean) | undefined>)[hook] = undefined
  })

  it('restores routed state on throw and has behavior-bearing child/route/malformed-wire RED teeth', () => {
    const boom = transform(routed(), () => { throw new Error('dispatch boom') })
    const grammar = dispatch(literal('a'), when('a', boom))
    const prog = program(grammar)
    const maps: Record<string, (input: string, pos: number, ctx: ParseContext) => unknown> = {
      reference: execRules(prog).Entry! as (input: string, pos: number, ctx: ParseContext) => unknown,
      closure: tableRules({ ...prog, asm: [] }).Entry! as (input: string, pos: number, ctx: ParseContext) => unknown,
      emitted: tableRules(prog).Entry! as (input: string, pos: number, ctx: ParseContext) => unknown,
      precompiled: tableRules(precompiled(prog)).Entry! as (input: string, pos: number, ctx: ParseContext) => unknown,
    }
    const sourceSentinel = { value: 'outer', span: { start: 7, end: 12 } }
    const sourceCtx = { trackLines: false, _routed: sourceSentinel } as ParseContext
    expect(() => grammar.parse('a', 0, sourceCtx)).toThrow('dispatch boom')
    expect(sourceCtx._routed).toBe(sourceSentinel)
    for (const [name, entry] of Object.entries(maps)) {
      const sentinel = { value: 'outer', span: { start: 7, end: 12 } }
      const ctx = { trackLines: false, _routed: sentinel } as ParseContext
      expect(() => entry('a', 0, ctx), name).toThrow('dispatch boom')
      expect(ctx._routed, name).toBe(sentinel)
    }

    const base = matrix()
    const baseProg = program(base)
    const ip = dispatchIp(baseProg)
    const plantedCode = [...baseProg.code]
    plantedCode[ip + 6] = plantedCode[ip + 7]!
    const wrongChild = ownTableProgram({ ...baseProg, code: plantedCode, asm: [] })
    expect(projection(tableRules(wrongChild).Entry! as Entry, 'exact!'))
      .not.toEqual(projection(base as Entry, 'exact!'))

    const raw = baseProg.dsp[baseProg.code[ip + 2]!]!
    const wrongMatcher = ownTableProgram({
      ...baseProg,
      dsp: baseProg.dsp.map((d, i) => i === baseProg.code[ip + 2]
        ? { ...raw, match: raw.match.map((m, mi) => mi === 0 ? [m[0], m[1], m[2], 1] : m) }
        : d),
      asm: [],
    })
    expect(projection(tableRules(wrongMatcher).Entry! as Entry, 'prefix:'))
      .not.toEqual(projection(base as Entry, 'prefix:'))

    const emitted = emitAssemblySource(resolveTable(baseProg), baseProg, STRICT)
    const wrongRouteSource = emitted.source.replace(
      'ctx._routed={value:key,span:{start:pos,end:selEnd}}',
      'ctx._routed=undefined',
    )
    expect(wrongRouteSource).not.toBe(emitted.source)
    const wrongRoute = tableRules(precompiled(baseProg, () => wrongRouteSource)).Entry! as Entry
    expect(projection(wrongRoute, 'exact!')).not.toEqual(projection(base as Entry, 'exact!'))

    const malformed = ownTableProgram({
      ...baseProg,
      dsp: baseProg.dsp.map((d, i) => i === baseProg.code[ip + 2]
        ? { ...raw, key: ['exact'], keyArm: [99] }
        : d),
      asm: [],
    })
    const malformedEntry = tableRules(malformed).Entry! as Entry
    expect(() => projection(malformedEntry, 'exact!')).toThrow(/table: malformed dispatch/)
  })
})
