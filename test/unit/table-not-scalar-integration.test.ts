import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  classifiedTrivia, completionsAt, cstBuildHost, dispatch, keywords, literal, node, not,
  regex, rules, run, sequence, when, word,
} from '../../src/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { defaultAssemblyCfgs, emitFoldedModule, emitTableModule } from '../../src/table/emit.ts'
import { encodeTable, type TableSettings } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_NOT } from '../../src/table/ops.ts'
import {
  foldPrograms, resolveTable, unfoldVariant, type PrecompiledAssembly, type TableProgram,
} from '../../src/table/program.ts'
import { scalarTerminalNotChild } from '../../src/table/scalar-terminal.ts'
import type { Combinator, ParseContext, ParseResult } from '../../src/types.ts'

type Entry = Parameters<typeof run>[0]
const DIR = path.dirname(fileURLToPath(import.meta.url))
const TABLE_RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/index.ts')).href
const FOLD_RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/fold.ts')).href
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function program(entry: Combinator<unknown>, settings: TableSettings = {}): TableProgram {
  return encodeTable({ Entry: entry }, settings)
}

function notIp(prog: TableProgram): number {
  const sites = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_NOT)
  expect(sites).toHaveLength(1)
  return sites[0]!
}

function entries(prog: TableProgram, interpreter: Combinator<unknown>): Record<string, Entry> {
  return {
    interpreter: interpreter as Entry,
    reference: execRules(prog).Entry! as Entry,
    closure: tableRules({ ...prog, asm: [] }).Entry! as Entry,
    emitted: tableRules(prog).Entry! as Entry,
  }
}

function lowLevel(entry: Entry, input: string): ParseResult<unknown> {
  const ctx = createParseContext()
  return typeof entry === 'function'
    ? entry(input, 0, ctx) as ParseResult<unknown>
    : (entry as Combinator<unknown>).parse(input, 0, ctx)
}

function projected(entry: Entry, input: string, opts: Parameters<typeof run>[2] = {}): unknown {
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

async function loadPrecompiledModule(
  prog: TableProgram,
  mutate: (source: string) => string = source => source,
): Promise<{ rules: Record<string, Entry>; source: string }> {
  const emitted = emitTableModule(prog, {
    name: 'grammar',
    runtime: TABLE_RUNTIME,
    runtimeRef: 'tableRules',
    fnSources: prog.fns.map(fn => String(fn)),
    assemblies: defaultAssemblyCfgs(prog),
  })
  const source = mutate(emitted)
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-not-scalar-module-'))
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const file = path.join(dir, 'grammar.ts')
  writeFileSync(file, source)
  const loaded = await import(/* @vite-ignore */ pathToFileURL(file).href) as { grammar: Record<string, Entry> }
  return { rules: loaded.grammar, source }
}

function precompiled(prog: TableProgram): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory']
  return {
    ...prog,
    asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }],
  }
}

async function loadFoldedModule(
  folded: ReturnType<typeof foldPrograms>,
): Promise<Record<string, Record<string, Entry>>> {
  const source = emitFoldedModule(folded, {
    runtime: FOLD_RUNTIME,
    fnSources: folded.base.fns.map(fn => String(fn)),
    names: { plain: 'plainGrammar', tracked: 'trackedGrammar' },
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-not-scalar-fold-'))
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const file = path.join(dir, 'grammar.ts')
  writeFileSync(file, source)
  const loaded = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
    plainGrammar: Record<string, Entry>
    trackedGrammar: Record<string, Entry>
  }
  return { plain: loaded.plainGrammar, tracked: loaded.trackedGrammar }
}

function blockFunctionConstructor<T>(body: () => T): T {
  const real = globalThis.Function
  globalThis.Function = new Proxy(real, {
    construct(): object { throw new Error('Function constructor reached after artifact import') },
    apply(): unknown { throw new Error('Function constructor reached after artifact import') },
  })
  try {
    return body()
  } finally {
    globalThis.Function = real
  }
}

describe('direct-terminal not() integration teeth', () => {
  it('loads a real precompiled emitTableModule artifact and parses under a CSP Function block', async () => {
    const grammar = sequence(not(regex(/[a-z]+/)), literal('?'))
    const prog = program(grammar)
    const loaded = await loadPrecompiledModule(prog)
    expect(loaded.source).toMatch(/\ba:\[\{key:/)
    expect(blockFunctionConstructor(() => projected(loaded.rules.Entry!, '?')))
      .toEqual(projected(grammar as Entry, '?'))
    expect(blockFunctionConstructor(() => projected(loaded.rules.Entry!, 'abc?')))
      .toEqual(projected(grammar as Entry, 'abc?'))
  })

  it('executes compact fold/unfold and a real folded module without applying the plain scalar proof to tracked rows', async () => {
    const grammar = sequence(literal('\n'), not(literal('!')), literal('x'))
    const plain = program(grammar)
    const tracked = program(grammar, { trackLines: true })
    expect(scalarTerminalNotChild(plain.code, notIp(plain))).toBeGreaterThanOrEqual(0)
    expect(scalarTerminalNotChild(tracked.code, notIp(tracked))).toBe(-1)

    const folded = foldPrograms({ plain, tracked }, 'plain')
    const loaded = await loadFoldedModule(folded)
    for (const [name, direct] of Object.entries({ plain, tracked })) {
      const unfolded = unfoldVariant(folded, name)
      expect([...unfolded.code]).toEqual([...direct.code])
      const viaFold = tableRules(unfolded).Entry! as Entry
      const viaDirect = tableRules(direct).Entry! as Entry
      for (const input of ['\nx', '\n!x', '']) {
        expect(projected(viaFold, input), `${name}: ${JSON.stringify(input)}`)
          .toEqual(projected(viaDirect, input))
        expect(projected(loaded[name]!.Entry!, input), `module ${name}: ${JSON.stringify(input)}`)
          .toEqual(projected(viaDirect, input))
      }
    }
    // The tracked export is genuinely selected: line spans differ after the
    // leading newline, rather than two exported names observing one parser.
    expect(projected(loaded.plain!.Entry!, '\nx')).not.toEqual(projected(loaded.tracked!.Entry!, '\nx'))
  })

  it('keeps completionsAt identical on child-match/fail and tolerant probe paths', () => {
    const grammar = sequence(not(literal('x')), literal('y'))
    const prog = program(grammar, { recovery: true })
    const closure = tableRules({ ...prog, asm: [] }).Entry! as Entry
    const closureProbe = {
      ...grammar,
      parse: (input: string, pos: number, ctx: ParseContext) =>
        (closure as (input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>)(input, pos, ctx),
    }
    for (const tolerant of [false, true]) {
      for (const [input, offset] of [['', 0], ['x', 0], ['y', 0], ['xy', 1]] as const) {
        const expected = completionsAt(grammar, input, offset, { tolerant }).slice().sort()
        expect(completionsAt(closureProbe, input, offset, { tolerant }).slice().sort(), `${input}@${offset} tolerant=${tolerant}`)
          .toEqual(expected)
      }
    }
  })

  it('preserves full run projection, selected root trivia, real CST, and committed envelopes', async () => {
    const trivia = classifiedTrivia({
      whitespace: regex(/[ \t\n\r\f]+/),
      blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
    })
    const grammar = rules({ trivia }, () => ({
      Entry: node('Doc', sequence(not(literal('x')), literal('a'), literal('b'))),
    })) as Record<string, Combinator<unknown>>
    const prog = encodeTable(grammar, { hostMode: 'cst' })
    const es: Record<string, Entry> = {
      interpreter: grammar.Entry! as Entry,
      reference: execRules(prog).Entry! as Entry,
      closure: tableRules({ ...prog, asm: [] }).Entry! as Entry,
      emitted: tableRules(prog).Entry! as Entry,
    }
    const precompiledModule = await loadPrecompiledModule(prog)
    es.precompiledModule = precompiledModule.rules.Entry!
    const input = 'a /*x*/ b tail'
    const opts = { build: cstBuildHost({ tags: true }), rootTrivia: { select: ['blockComment'] as const } }
    const expected = projected(es.interpreter!, input, opts)
    expect(expected).toMatchObject({
      ok: true,
      unconsumedFrom: 10,
      rootTrivia: { rows: [1, 8, 2, 7, 0], select: ['blockComment'], text: ['/*x*/'] },
    })
    for (const [name, entry] of Object.entries(es)) expect(projected(entry, input, opts), name).toEqual(expected)
    expect(blockFunctionConstructor(() => projected(precompiledModule.rules.Entry!, input, opts))).toEqual(expected)

    // Permanent semantic RED plant: corrupt every emitted strict factory's
    // scalar-NOT success. The imported CST artifact must now disagree. If the
    // test silently selected a closure fallback, this would remain green.
    const plantedModule = await loadPrecompiledModule(prog, source => {
      const planted = source.replaceAll('{EC.e=pos;return null}', '{EC.e=pos;return FAIL}')
      expect(planted).not.toBe(source)
      return planted
    })
    expect(projected(plantedModule.rules.Entry!, input, opts)).not.toEqual(expected)

    const committed = dispatch(literal('a'), when('a', not(literal('x'))))
    const committedEntries = entries(program(committed), committed)
    const envelope = lowLevel(committedEntries.interpreter!, 'ax')
    expect(envelope).toMatchObject({ ok: false, committed: true, expected: ['not(literal)'] })
    for (const [name, entry] of Object.entries(committedEntries)) {
      expect(lowLevel(entry, 'ax'), name).toEqual(envelope)
    }
  })

  it('restores one shared pooled RegExp across a same-assembly nested parse on a different input', () => {
    const shared = regex(/[a-z]+/)
    const inner = not(shared)
    let innerEntry: Entry = inner as Entry
    // An emittable callback is the gate between the two recognitions: it calls
    // this same assembly's Inner rule on another input immediately before the
    // Outer NOT uses the shared pooled RegExp again.
    const outer = sequence(
      node('Reenter', literal('!'), () => !lowLevel(innerEntry, 'abc').ok),
      not(shared),
      literal('?'),
    )
    const grammar = { Inner: inner, Outer: outer }
    const prog = encodeTable(grammar)
    const notSites = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_NOT)
    expect(notSites).toHaveLength(2)
    const childSpecs = notSites.map(ip => {
      const child = scalarTerminalNotChild(prog.code, ip)
      expect(child).toBeGreaterThanOrEqual(0)
      return prog.code[child + 1]!
    })
    expect(new Set(childSpecs)).toEqual(new Set([childSpecs[0]!]))
    const emittedSource = emitAssemblySource(resolveTable(prog), prog, STRICT).source
    expect(emittedSource).toContain(`RECOG[${childSpecs[0]}]`)

    const engines: Record<string, Record<string, Entry>> = {
      closure: tableRules({ ...prog, asm: [] }) as Record<string, Entry>,
      emitted: tableRules(prog) as Record<string, Entry>,
      precompiled: tableRules(precompiled(prog)) as Record<string, Entry>,
    }
    for (const input of ['!?', '!z?', '!']) {
      innerEntry = grammar.Inner as Entry
      const expected = projected(grammar.Outer as Entry, input)
      for (const [name, rules] of Object.entries(engines)) {
        innerEntry = rules.Inner!
        expect(projected(rules.Outer!, input), `${name}: ${input}`).toEqual(expected)
      }
    }

    // Permanent structural RED plant: point the second direct child at a new
    // pooled regex. The shared-const assertion above must detect the defect.
    const plantedCode = [...prog.code]
    const sharedChild = scalarTerminalNotChild(plantedCode, notSites[1]!)
    const distinctChild = plantedCode.length
    plantedCode.push(...plantedCode.slice(sharedChild, sharedChild + 3))
    plantedCode[distinctChild + 1] = prog.k.length
    plantedCode[notSites[1]! + 1] = distinctChild
    const plantedSpecs = notSites.map(ip => {
      const child = scalarTerminalNotChild(plantedCode, ip)
      return plantedCode[child + 1]!
    })
    expect(new Set(plantedSpecs).size).toBe(2)
  })

  it('covers word/keywords boundaries, nonzero positions, and zero-width regex matches', () => {
    const cases: ReadonlyArray<{ grammar: Combinator<unknown>; inputs: readonly string[] }> = [
      {
        grammar: sequence(literal('!'), not(word('if', 'A-Za-z')), literal('?')),
        inputs: ['!?', '!if?', '!iffy?', '?'],
      },
      {
        grammar: sequence(literal('!'), not(keywords(['if', 'else'], { boundary: 'A-Za-z' })), literal('?')),
        inputs: ['!?', '!if?', '!iffy?', '!else?', '!elsewhere?'],
      },
      {
        grammar: sequence(literal('!'), not(regex(/a*/)), literal('?')),
        inputs: ['!?', '!a?', '!bbb?', ''],
      },
    ]
    for (const { grammar, inputs } of cases) {
      const prog = program(grammar)
      expect(scalarTerminalNotChild(prog.code, notIp(prog))).toBeGreaterThanOrEqual(0)
      const es = entries(prog, grammar)
      for (const input of inputs) {
        const expected = projected(es.interpreter!, input)
        for (const [name, entry] of Object.entries(es)) expect(projected(entry, input), `${name}: ${input}`).toEqual(expected)
      }
    }
  })
})
