import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  choice, classifiedTrivia, completionsAt, cstBuildHost, dispatch, label, literal, node,
  regex, rules, run, sequence, when,
} from '../../src/index.ts'
import { buildGrammarPlan } from '../../src/compiler/grammar-coverage-ids.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { defaultAssemblyCfgs, emitFoldedModule, emitTableModule } from '../../src/table/emit.ts'
import { encodeTable, type TableSettings } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
import {
  foldPrograms, ownTableProgram, resolveTable, unfoldVariant, type PrecompiledAssembly, type TableProgram,
} from '../../src/table/program.ts'
import type { Combinator } from '../../src/types.ts'

type Entry = Parameters<typeof run>[0]
const DIR = path.dirname(fileURLToPath(import.meta.url))
const TABLE_RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/index.ts')).href
const FOLD_RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/fold.ts')).href
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
const CLOSURE_CFG = { ...STRICT, hostReadsChildren: true }

function program(entry: Combinator<unknown>, settings: TableSettings = {}): TableProgram {
  return encodeTable({ Entry: entry }, settings)
}

function choiceIp(prog: TableProgram): number {
  const ips = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_CHOICE)
  expect(ips).toHaveLength(1)
  return ips[0]!
}

function ordered(n: 2 | 3, nonAscii = false): Combinator<unknown> {
  const lead = () => nonAscii ? regex(/[a\u0080]/) : literal('a')
  const arms: Combinator<unknown>[] = [
    sequence(lead(), literal('x')),
    sequence(lead(), literal('y')),
  ]
  if (n === 3) arms.push(literal('b'))
  return n === 2 ? choice(arms[0]!, arms[1]!) : choice(arms[0]!, arms[1]!, arms[2]!)
}

function exclusive(n: 2 | 3): Combinator<unknown> {
  return n === 2
    ? choice(literal('a'), literal('b'))
    : choice(literal('a'), literal('b'), literal('c'))
}

function orderedMany(n: number): Combinator<unknown> {
  const arms: Combinator<unknown>[] = Array.from({ length: n - 1 }, (_, i) =>
    sequence(literal('a'), literal(String.fromCharCode(33 + i))))
  arms.push(literal('b'))
  return choice(...arms as [Combinator<unknown>, ...Combinator<unknown>[]])
}

function exclusiveMany(n: number): Combinator<unknown> {
  const arms: Combinator<unknown>[] = Array.from({ length: n }, (_, i) => literal(String.fromCharCode(33 + i)))
  return choice(...arms as [Combinator<unknown>, ...Combinator<unknown>[]])
}

function projection(entry: Entry, input: string, opts: Parameters<typeof run>[2] = {}): unknown {
  const result = run(entry, input, opts)
  return {
    ok: result.ok,
    value: result.value,
    span: result.span,
    expected: result.expected,
    errors: result.errors,
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
  const source = mutate(emitted.source)
  const factory = new Function(...EMITTED_PARAMS, source) as PrecompiledAssembly['factory']
  return { ...prog, asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }] }
}

function engines(grammar: Combinator<unknown>, prog = program(grammar)): Record<string, Entry> {
  return {
    interpreter: grammar as Entry,
    reference: execRules(prog).Entry! as Entry,
    closure: tableRules({ ...prog, asm: [] }).Entry! as Entry,
    emitted: tableRules(prog).Entry! as Entry,
    precompiled: tableRules(precompiled(prog)).Entry! as Entry,
  }
}

function expectIdentity(entries: Record<string, Entry>, inputs: readonly string[], opts: Parameters<typeof run>[2] = {}): void {
  for (const input of inputs) {
    const expected = projection(entries.interpreter!, input, opts)
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
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-choice-direct-'))
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const file = path.join(dir, 'grammar.ts')
  writeFileSync(file, source)
  return (await import(/* @vite-ignore */ pathToFileURL(file).href) as { grammar: Record<string, Entry> }).grammar
}

function blockFunctionConstructor<T>(body: () => T): T {
  const real = globalThis.Function
  globalThis.Function = new Proxy(real, {
    construct(): object { throw new Error('Function constructor reached after module import') },
    apply(): unknown { throw new Error('Function constructor reached after module import') },
  })
  try { return body() } finally { globalThis.Function = real }
}

describe('direct-bound choice topology', () => {
  it('binds every arity without fixed-membership arrays while keeping masks as dynamic classifier data', () => {
    for (const grammar of [ordered(2), ordered(3)]) {
      const prog = program(grammar)
      const ip = choiceIp(prog)
      const table = resolveTable(prog)
      expect(table.disp[prog.code[ip + 1]!]!.exclusive).toBe(false)
      const emitted = emitAssemblySource(table, prog, STRICT)
      expect(emitted.plan.classes).toEqual([])
      expect(emitted.plan.armExpected).toEqual([])
      expect(emitted.plan.masks).toEqual([~(prog.code[ip + 1]!)])
      expect(emitted.source).not.toMatch(/\b(?:AFX|CLS)\[/)
      expect(emitted.source).toMatch(/DISP\[\d+\]\.armCls\[0\]/)
      expect(emitted.source).not.toMatch(/arms\[|armFx\[|gates\[/)
      const closureBody = assemble(table, { ...prog, asm: [] }, CLOSURE_CFG).pieces.Entry!.toString()
      expect(closureBody).toMatch(/\ba0\(input, pos, ctx\)/)
      expect(closureBody).not.toMatch(/arms\[|armFx\[|gates\[/)
    }

    for (const grammar of [exclusive(2), exclusive(3)]) {
      const prog = program(grammar)
      const ip = choiceIp(prog)
      const table = resolveTable(prog)
      expect(table.disp[prog.code[ip + 1]!]!.exclusive).toBe(true)
      const emitted = emitAssemblySource(table, prog, STRICT)
      expect(emitted.plan).toEqual({ classes: [], armExpected: [], masks: [] })
      expect(emitted.source).not.toMatch(/\b(?:AFX|CLS)\[/)
    }

    for (const n of [4, 5, 8, 21, 31, 32, 33]) {
      const prog = program(orderedMany(n))
      const ip = choiceIp(prog)
      const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
      expect(emitted.plan.classes, `n${n}`).toEqual([])
      expect(emitted.plan.armExpected, `n${n}`).toEqual([])
      expect(emitted.plan.masks, `n${n}`).toEqual(n <= 32 ? [~(prog.code[ip + 1]!)] : [])
      expect(emitted.source, `n${n}`).not.toMatch(/\b(?:AFX|CLS)\[/)
      expect(emitted.source, `n${n}`).not.toMatch(/arms\[|armFx\[|gates\[/)
      // One fallthrough prefix helper has one case per arm. The old generated
      // `i` prefix checks per arm (210 at n21, 496 at n32) were quadratic.
      expect(emitted.source, `n${n}`).not.toMatch(/if\(prev</)
      expect(emitted.source.match(/case \d+:if\(target<=/g)?.length ?? 0, `n${n}`)
        .toBe(n <= 32 ? n : 0)
    }

    const source = readFileSync(path.resolve(DIR, '../../src/table/assemble.ts'), 'utf8')
    const choiceCase = source.slice(source.indexOf('case OP_CHOICE:'), source.indexOf('/* ── greedyClassify'))
    expect(choiceCase).not.toMatch(/const arms:|const armFx:|const gates:/)
    const maskedBlock = source.slice(
      source.indexOf('function maskedChoiceBlock('), source.indexOf('function generalChoiceBlock('),
    )
    expect(maskedBlock).toMatch(/a0\(input, pos, ctx\)/)
    expect(maskedBlock).toMatch(/a3\(input, pos, ctx\)/)
    expect(maskedBlock).not.toMatch(/maskable|classHas|arms\[|armFx\[|gates\[/)
    const generalBlock = source.slice(
      source.indexOf('function generalChoiceBlock('), source.indexOf('function exclusiveChoiceBlock('),
    )
    expect(generalBlock).toMatch(/a0\(input, pos, ctx\)/)
    expect(generalBlock).toMatch(/a3\(input, pos, ctx\)/)
    expect(generalBlock).not.toMatch(/\bbits\b|maskable|arms\[|armFx\[|gates\[/)
    const exclusiveBlock = source.slice(
      source.indexOf('function exclusiveChoiceBlock('), source.indexOf('function trackLinesInto('),
    )
    expect(exclusiveBlock).toMatch(/a0\(input, pos, ctx\)/)
    expect(exclusiveBlock).toMatch(/a3\(input, pos, ctx\)/)
    expect(exclusiveBlock).not.toMatch(/arms\[|armFx\[|gates\[/)

    // The signed-mask boundary is selected while the assembly is built. n32's
    // public piece chooses between its already-bound ASCII-mask and general
    // bodies using only the dynamic lead; n33 has no mask, bits or masked block
    // in its parse closure at all.
    const p32 = program(orderedMany(32))
    const body32 = assemble(resolveTable(p32), { ...p32, asm: [] }, CLOSURE_CFG).pieces.Entry!.toString()
    expect(body32).toContain('mask[c < 0 ? 128 : c]')
    expect(body32).not.toContain('maskable')
    const p33 = program(orderedMany(33))
    const body33 = assemble(resolveTable(p33), { ...p33, asm: [] }, CLOSURE_CFG).pieces.Entry!.toString()
    expect(body33).not.toMatch(/\b(?:mask|bits|masked|maskable)\b/)
  })

  it('preserves ordered skips, later success, all-fail diagnostics, EOF and non-ASCII in every engine', () => {
    for (const n of [2, 3] as const) {
      const ascii = ordered(n)
      expectIdentity(engines(ascii), n === 2 ? ['ax', 'ay', 'az', 'b', ''] : ['ax', 'ay', 'az', 'b', 'c', ''])
      const unicode = ordered(n, true)
      expectIdentity(engines(unicode), ['\u0080x', '\u0080y', '\u0080z', 'ax', 'ay', 'c', ''])
    }
    for (const n of [4, 5, 8, 21, 31, 32, 33]) {
      const grammar = orderedMany(n)
      const lastSuffix = String.fromCharCode(33 + n - 2)
      expectIdentity(engines(grammar), ['a!', `a${lastSuffix}`, 'az', 'b', 'c', ''])
    }
  })

  it('preserves exclusive direct selection, dispatch misses and selected-arm commitment', () => {
    expectIdentity(engines(exclusive(2)), ['a', 'b', 'c', '\u0080', ''])
    expectIdentity(engines(exclusive(3)), ['a', 'b', 'c', 'd', '\u0080', ''])
    for (const n of [4, 5, 8, 21]) {
      const grammar = exclusiveMany(n)
      expectIdentity(engines(grammar), ['!', String.fromCharCode(32 + n), 'z', '\u0080', ''])
    }

    const committed = choice(
      dispatch(literal('a'), when('a', literal('x'))),
      literal('a'),
    )
    const es = engines(committed)
    expect(projection(es.interpreter!, 'ay')).toMatchObject({ ok: false, expected: ['"x"'] })
    expectIdentity(es, ['ax', 'ay', 'a', 'b'])
  })

  it('rolls back CST/raw/trivia sinks and preserves probe, tolerant, tracked and coverage modes', () => {
    const trivia = classifiedTrivia({
      whitespace: regex(/[ \t\n\r\f]+/),
      blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
    })
    const grammarMap = rules({ trivia }, () => ({
      Entry: choice(
        sequence(node('Discarded', literal('a')), literal('x')),
        sequence(node('Kept', literal('a')), literal('y')),
        literal('b'),
      ),
    })) as Record<string, Combinator<unknown>>
    const grammar = grammarMap.Entry!
    const opts = { build: cstBuildHost({ tags: true }), rootTrivia: { select: ['blockComment'] as const } }
    expectIdentity(engines(grammar), ['a /*one*/ y tail', 'a z', 'b'], opts)

    const base = ordered(3)
    const closure = tableRules({ ...program(base), asm: [] }).Entry! as Entry
    const closureProbe = {
      ...base,
      parse: closure as (input: string, pos: number, ctx: Parameters<Combinator<unknown>['parse']>[2]) => ReturnType<Combinator<unknown>['parse']>,
    }
    for (const [input, offset] of [['', 0], ['az', 1], ['ay', 1], ['b', 0]] as const) {
      expect(completionsAt(closureProbe, input, offset).slice().sort()).toEqual(completionsAt(base, input, offset).slice().sort())
    }
    expectIdentity(engines(base, program(base, { recovery: true })), ['ax', 'ay', 'az', 'b', ''], { tolerant: true })
    const trackedEntries = engines(base, program(base, { trackLines: true }))
    for (const input of ['ax', 'ay', 'az', 'b', '']) {
      const expected = projection(trackedEntries.reference!, input)
      for (const [name, entry] of Object.entries(trackedEntries)) {
        if (name !== 'interpreter') expect(projection(entry, input), name).toEqual(expected)
      }
    }

    const coveragePlan = buildGrammarPlan(label('direct-choice', base))
    const covered = label('direct-choice', base)
    const coveredProg = program(covered, { coverage: coveragePlan })
    expectIdentity({
      interpreter: covered as Entry,
      reference: execRules(coveredProg).Entry! as Entry,
      closure: tableRules({ ...coveredProg, asm: [] }).Entry! as Entry,
      emittedFallback: tableRules(coveredProg).Entry! as Entry,
    }, ['ax', 'ay', 'az', 'b', ''])
  })

  it('round-trips real precompiled/folded modules under CSP and has a behavior-bearing RED plant', async () => {
    const grammar = ordered(3)
    const prog = program(grammar)
    const loaded = await loadModule(prog)
    for (const input of ['ax', 'ay', 'az', 'b', '']) {
      expect(blockFunctionConstructor(() => projection(loaded.Entry!, input))).toEqual(projection(grammar as Entry, input))
    }

    const tracked = program(grammar, { trackLines: true })
    const folded = foldPrograms({ plain: prog, tracked }, 'plain')
    const source = emitFoldedModule(folded, {
      runtime: FOLD_RUNTIME,
      fnSources: folded.base.fns.map(fn => String(fn)),
      names: { plain: 'plainGrammar', tracked: 'trackedGrammar' },
    })
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-choice-fold-'))
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const file = path.join(dir, 'grammar.ts')
    writeFileSync(file, source)
    const modules = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
      plainGrammar: Record<string, Entry>
      trackedGrammar: Record<string, Entry>
    }
    for (const [name, direct] of Object.entries({ plain: prog, tracked })) {
      expect([...unfoldVariant(folded, name).code]).toEqual([...direct.code])
      for (const input of ['ax', 'ay', 'az', 'b', '']) {
        expect(projection(modules[`${name}Grammar` as keyof typeof modules].Entry!, input))
          .toEqual(projection(tableRules(direct).Entry! as Entry, input))
      }
    }

    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
    const target = /\{const v=(_pf\d+)\(input,pos,ctx\)\nif\(v!==FAIL\)return v\}/
    const calls = [...emitted.source.matchAll(new RegExp(target.source, 'g'))]
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const wrong = emitted.source.replace(calls[1]![0], calls[1]![0].replace(calls[1]![1]!, calls[0]![1]!))
    expect(wrong).not.toBe(emitted.source)
    const broken = tableRules(precompiled(prog, () => wrong)).Entry! as Entry
    expect(projection(broken, 'ay')).not.toEqual(projection(grammar as Entry, 'ay'))

    // Closure RED: swap the second child operand with the first in a cloned
    // TableProgram. The closure engine must now choose the wrong continuation.
    const plantedCode = [...prog.code]
    const ip = choiceIp(prog)
    const base = ip + 4
    plantedCode[base + 1] = plantedCode[base]!
    const planted = ownTableProgram({ ...prog, code: plantedCode, asm: [] })
    const brokenClosure = tableRules(planted).Entry! as Entry
    expect(projection(brokenClosure, 'ay')).not.toEqual(projection(grammar as Entry, 'ay'))

    // The signed bit boundary is behavior-bearing: arm 31 uses bit 31, while
    // arity 33 deliberately leaves the Uint32 mask path. Planting arm 31's test
    // as arm 30 must make the n32 precompiled engine reject its last arm.
    const boundary32 = orderedMany(32)
    const boundaryProg = program(boundary32)
    const boundarySource = emitAssemblySource(resolveTable(boundaryProg), boundaryProg, STRICT).source
    expect(boundarySource).toContain('(bits&-2147483648)')
    const wrongBoundary = boundarySource.replace('(bits&-2147483648)', '(bits&1073741824)')
    expect(wrongBoundary).not.toBe(boundarySource)
    const brokenBoundary = tableRules(precompiled(boundaryProg, () => wrongBoundary)).Entry! as Entry
    expect(projection(brokenBoundary, 'b')).not.toEqual(projection(boundary32 as Entry, 'b'))

    // A direct mask plan points to the authoritative dispatch row. An invalid
    // pointer must refuse at assembly load, not quietly manufacture a different
    // classifier from absent data.
    const invalidEmitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
    const invalidFactory = new Function(
      ...EMITTED_PARAMS, invalidEmitted.source,
    ) as PrecompiledAssembly['factory']
    const invalidPlan = {
      ...invalidEmitted.plan,
      masks: [~9999],
    }
    const invalid = ownTableProgram({
      ...prog,
      asm: [{ key: 0, factory: invalidFactory, plan: invalidPlan, reached: [...invalidEmitted.reached] }],
    })
    expect(() => projection(tableRules(invalid).Entry! as Entry, 'ax'))
      .toThrow(/invalid MASK plan source/)

    // Nested entry into the SAME assembly while a four-arm choice is in flight.
    // The outer first arm materialises a node, re-enters Inner on another input,
    // then fails its suffix; marks, end position and expected-prefix state must
    // resume before the second arm succeeds.
    const inner = orderedMany(5)
    const hook = '__parsemanChoiceDirectInner__'
    const reenter = node('Reenter', literal('a'), () => {
      const enter = (globalThis as unknown as { __parsemanChoiceDirectInner__: () => boolean })
        .__parsemanChoiceDirectInner__
      if (!enter()) throw new Error('nested choice did not consume')
      return 'nested'
    })
    const outer = choice(
      sequence(reenter, literal('x')),
      sequence(literal('a'), literal('y')),
      literal('b'),
      literal('c'),
    )
    const nestedGrammar = { Inner: inner, Outer: outer }
    const nestedProg = encodeTable(nestedGrammar)
    const nestedMaps: Record<string, Record<string, Entry>> = {
      interpreter: nestedGrammar as unknown as Record<string, Entry>,
      reference: execRules(nestedProg) as Record<string, Entry>,
      closure: tableRules({ ...nestedProg, asm: [] }) as Record<string, Entry>,
      emitted: tableRules(nestedProg) as Record<string, Entry>,
      precompiled: tableRules(precompiled(nestedProg)) as Record<string, Entry>,
      module: await loadModule(nestedProg),
    }
    const installInner = (entry: Entry): void => {
      ;(globalThis as unknown as Record<string, () => boolean>)[hook] = () => {
        const nested = run(entry, 'a!')
        return nested.ok && nested.span.end === 2
      }
    }
    installInner(nestedMaps.interpreter!.Inner!)
    const nestedExpected = projection(nestedMaps.interpreter!.Outer!, 'ay')
    for (const [name, map] of Object.entries(nestedMaps)) {
      installInner(map.Inner!)
      expect(projection(map.Outer!, 'ay'), name).toEqual(nestedExpected)
    }
    ;(globalThis as unknown as Record<string, (() => boolean) | undefined>)[hook] = undefined
  })
})
