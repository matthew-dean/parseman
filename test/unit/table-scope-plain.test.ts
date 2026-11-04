import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  attempt, choice, classifiedTrivia, literal, node, noTrivia, optional, parser, regex, rules, run, sequence,
  type Combinator,
} from '../../src/index.ts'
import { hasOwnTriviaBoundary } from '../../src/combinators/trivia-boundary.ts'
import { run as interpreterRun } from '../../src/functional/run.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableVariants } from '../../src/table/fold.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_RX, OP_SCOPE, OP_SCOPE_PLAIN } from '../../src/table/ops.ts'
import {
  foldPrograms, ownTableProgram, resolveTable, type PrecompiledAssembly, type TableProgram,
} from '../../src/table/program.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

type Entry = Parameters<typeof run>[0]
type RunOptions = Parameters<typeof run>[2]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
const SELECTED = { rootTrivia: { select: ['blockComment'] as const } }
const DIR = path.dirname(fileURLToPath(import.meta.url))
const TABLE_RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/assemble.ts')).href

const documentTrivia = () => classifiedTrivia({
  whitespace: regex(/[ \t\n\r\f]+/),
  blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
})

function precompiled(prog: TableProgram): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory']
  return {
    ...prog,
    asm: [{ key: 0, arity: EMITTED_PARAMS.length, factory, plan: emitted.plan, reached: [...emitted.reached] }],
  }
}

function engines(
  grammar: Record<string, Combinator<unknown>>,
  entry: string,
): { prog: TableProgram; entries: Record<string, Entry> } {
  const prog = encodeTable(grammar)
  return {
    prog,
    entries: {
      run: grammar[entry]! as Entry,
      emitted: tableRules(prog)[entry]! as Entry,
      closure: tableRules({ ...prog, asm: [] })[entry]! as Entry,
      reference: execRules(prog)[entry]! as Entry,
      precompiled: tableRules(precompiled(prog))[entry]! as Entry,
      folded: tableVariants(foldPrograms({ base: { ...prog, asm: [] } }, 'base'), 'base')[entry]! as Entry,
    },
  }
}

function outcome(entry: Entry, input: string, drive: typeof run = run, options: RunOptions = SELECTED): unknown {
  const result = drive(entry, input, options)
  return {
    ok: result.ok,
    value: result.value,
    // Offsets only. A scope that asks for lines turns them on for a whole table,
    // and for that scope alone in the interpreter.
    span: result.span && { start: result.span.start, end: result.span.end },
    expected: result.ok ? undefined : result.expected,
    unconsumedFrom: result.unconsumedFrom,
    rootTrivia: result.rootTrivia === undefined ? undefined : {
      rows: [...result.rootTrivia.rows],
      select: [...result.rootTrivia.select],
      text: result.rootTrivia.index.entries.length === 0
        ? []
        : Array.from(
            { length: result.rootTrivia.index.entries.length },
            (_, i) => result.rootTrivia!.index.entries.text(i, input),
          ),
    },
  }
}

function expectIdentity(entries: Record<string, Entry>, input: string, options: RunOptions = SELECTED): void {
  // `run` from the package root tables a grammar first, so only this driver walks
  // the combinators. Every other leg answers to it.
  const expected = outcome(entries.run!, input, interpreterRun, options)
  for (const [name, entry] of Object.entries(entries)) {
    expect(outcome(entry, input, run, options), `${name}: ${JSON.stringify(input)}`).toEqual(expected)
  }
}

function syntheticScopeTargets(prog: TableProgram): Set<string> {
  const entries = new Set(Object.values(prog.rules))
  const bodyNames = new Map<number, string[]>()
  for (const [name, ip] of Object.entries(prog.rules)) {
    expect(prog.code[ip], `entry ${name}`).toBe(OP_SCOPE_PLAIN)
    const body = prog.code[ip + 2]!
    const names = bodyNames.get(body) ?? []
    names.push(name)
    bodyNames.set(body, names)
  }
  const targets = new Set<string>()
  for (const ip of reachableIps(prog)) {
    if (prog.code[ip] !== OP_SCOPE_PLAIN || entries.has(ip)) continue
    for (const name of bodyNames.get(prog.code[ip + 2]!) ?? []) targets.add(name)
  }
  return targets
}

async function realModuleEntry(prog: TableProgram): Promise<Entry> {
  const source = emitTableModule({ ...prog, asm: [] }, {
    name: 'grammar', runtime: TABLE_RUNTIME, runtimeRef: 'tableRules', fnSources: prog.fns.map(f => String(f)),
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-scope-plain-'))
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const file = path.join(dir, 'grammar.ts')
  writeFileSync(file, source)
  const OriginalFunction = globalThis.Function
  globalThis.Function = function blockedFunction(): never {
    throw new Error('CSP Function blocked')
  } as unknown as FunctionConstructor
  try {
    const mod = await import(/* @vite-ignore */ pathToFileURL(file).href) as { grammar: Record<string, Entry> }
    return mod.grammar.First!
  } finally {
    globalThis.Function = OriginalFunction
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('artifact-neutral synthetic trivia scopes', () => {
  it('executes a precompiled classified-trivia factory', () => {
    const trivia = documentTrivia()
    const grammar = rules({ trivia }, () => ({
      Doc: sequence(literal('a'), literal('b')),
    })) as Record<string, Combinator<unknown>>
    const prog = encodeTable(grammar)
    const input = 'a   b'
    const expected = outcome(grammar.Doc! as Entry, input)

    // The current emitted factory takes the compact numeric no-row branch:
    // whitespace advances, but rootTrivia selects comments, so no row survives.
    expect(outcome(tableRules(precompiled(prog)).Doc! as Entry, input)).toEqual(expected)

  })

  it('uses a three-word row across every artifact reader without reading the following RX as policy', async () => {
    const trivia = documentTrivia()
    const grammar = rules({ trivia }, () => ({ First: regex(/a/), Second: regex(/b/) })) as Record<string, Combinator<unknown>>
    const { prog, entries } = engines(grammar, 'First')
    const first = prog.rules.First!

    expect(prog.code).toHaveLength(12)
    expect(prog.code.slice(first, first + 3)).toEqual([OP_SCOPE_PLAIN, 0, 0])
    expect(prog.code[first + 3]).toBe(OP_RX)
    expect(OP_RX & 2).toBe(2)
    entries.moduleCsp = await realModuleEntry(prog)
    expectIdentity(entries, 'a /*kept*/')

    const authored = encodeTable({ Root: parser({ trivia, rootCapture: 'opaque' }, regex(/a/)) })
    const policyScope = [...reachableIps(authored)].find(ip => authored.code[ip] === OP_SCOPE)
    expect(policyScope).toBeTypeOf('number')
    expect(authored.code[policyScope! + 3]).toBe(1)

    // Permanent semantic RED: spelling the three-word row as policy-bearing
    // OP_SCOPE makes the following RX opcode become strict-policy bit 2.
    const plantedCode = [...prog.code]
    plantedCode[first] = OP_SCOPE
    const planted = ownTableProgram({ ...prog, code: plantedCode })
    const message = /selected root trivia requires classifiedTrivia/
    const plantedEntries: Record<string, Entry> = {
      emitted: tableRules(planted).First! as Entry,
      closure: tableRules({ ...planted, asm: [] }).First! as Entry,
      reference: execRules(planted).First! as Entry,
      precompiled: tableRules(precompiled(planted)).First! as Entry,
      folded: tableVariants(foldPrograms({ base: { ...planted, asm: [] } }, 'base'), 'base').First! as Entry,
    }
    for (const [name, entry] of Object.entries(plantedEntries)) {
      expect(() => run(entry, 'a /*kept*/', SELECTED), name).toThrow(message)
    }
  })

  it('restores the reduced CSS var-family rules without losing selected comments', () => {
    const trivia = documentTrivia()
    const grammar = rules({ trivia }, (g: Record<string, Combinator<unknown>>) => ({
      VarFallbackBrace: sequence(literal('{'), literal('}')),
      VarFallbackCall: sequence(literal('f('), noTrivia(g.VarFallbackBrace!), literal(')')),
      VarCall: sequence(literal('var('), noTrivia(g.VarFallbackCall!), literal(')')),
      Root: noTrivia(sequence(literal('x:'), g.VarCall!)),
    })) as unknown as Record<string, Combinator<unknown>>
    const { prog, entries } = engines(grammar, 'Root')
    expect(syntheticScopeTargets(prog)).toEqual(new Set(['VarFallbackBrace', 'VarFallbackCall', 'VarCall']))
    expectIdentity(entries, 'x:var(/*a*/f(/*b*/{/*c*/}/*d*/)/*e*/)')
  })

  it('restores the reduced Less MathUnary/MixinReference rules under noTrivia', () => {
    const trivia = documentTrivia()
    const grammar = rules({ trivia }, (g: Record<string, Combinator<unknown>>) => ({
      MixinReference: sequence(literal('.'), literal('m')),
      Value: choice(attempt(noTrivia(g.MixinReference!)), literal('v')),
      MathUnary: sequence(optional(noTrivia(literal('-'))), g.Value!),
      Root: noTrivia(sequence(literal('a:'), g.MathUnary!)),
    })) as unknown as Record<string, Combinator<unknown>>
    const { prog, entries } = engines(grammar, 'Root')
    expect(syntheticScopeTargets(prog)).toEqual(new Set(['MathUnary', 'MixinReference']))
    expectIdentity(entries, 'a:- /*kept*/ . /*mix*/ m')
  })

  /*
   * `rules({ trackLines: true })` wraps every rule in `parser({ trackLines: true },
   * …)`, and a compose() build resolves a reference to that wrapper. It names no
   * trivia, so the rule still has its boundary: `Value`'s tail has to cross the
   * space before `!` however the reference got there. The line-tracked table
   * dropped the scope row and stopped at the `!`.
   */
  it.each([false, true])('a rule under noTrivia keeps its trivia in a compose() with trackLines: %s', (trackLines) => {
    const out = transformMacro(`import { compose, literal, noTrivia, optional, regex, rules, sequence } from 'parseman' with { type: 'macro' }
const ws = regex(/[ \\t\\n]+/)
export const parser = compose([rules({ trivia: ws${trackLines ? ', trackLines: true' : ''} }, g => ({
  Value: sequence(literal('c'), optional(sequence(literal('!'), literal('important')))),
  Declaration: noTrivia(sequence(literal('b:'), regex(/ */), g.Value)),
}))])`, path.join(DIR, 'tracked-scope-plain.ts'), new Set(['parseman']))
    expect(out?.warnings).toEqual([])
    expect(out?.code).not.toMatch(/\bcompose\s*\(/)
    const grammar = evalMacroModule<Record<string, Entry>>(out!.code, 'parser')
    expect(run(grammar.Declaration!, 'b: c !important').unconsumedFrom).toBeNull()
  })

  it('asks what a rule scope that names no trivia wraps, and stops at one that does', () => {
    const live = documentTrivia()
    const outer = (g: Record<string, Combinator<unknown>>) => noTrivia(sequence(literal('x:'), g.Body!))
    const pair = () => sequence(literal('a'), literal('b'))
    const tracked = rules({ trivia: live }, (g: Record<string, Combinator<unknown>>) => ({
      Body: parser({ trackLines: true }, pair()),
      Root: outer(g),
    })) as unknown as Record<string, Combinator<unknown>>
    const cleared = rules({ trivia: live }, (g: Record<string, Combinator<unknown>>) => ({
      Body: noTrivia(pair()),
      Root: outer(g),
    })) as unknown as Record<string, Combinator<unknown>>
    expect(syntheticScopeTargets(engines(tracked, 'Root').prog)).toEqual(new Set(['Body']))
    expectIdentity(engines(tracked, 'Root').entries, 'x:a b')
    expect(run(tracked.Root as Entry, 'x:a b').unconsumedFrom).toBeNull()
    expect(syntheticScopeTargets(engines(cleared, 'Root').prog)).toEqual(new Set())
    expectIdentity(engines(cleared, 'Root').entries, 'x:a b')
  })

  describe('a capture-only scope inherits its trivia', () => {
    const cases = {
      'under a noTrivia region': (g: Record<string, Combinator<unknown>>) => noTrivia(sequence(literal('x:'), g.Body!)),
      'under the ambient trivia': (g: Record<string, Combinator<unknown>>) => sequence(literal('x:'), g.Body!),
    }
    const build = (root: (g: Record<string, Combinator<unknown>>) => Combinator<unknown>, trivia: Combinator<unknown>) =>
      rules({ trivia }, (g: Record<string, Combinator<unknown>>) => ({
        Body: parser({ captureTrivia: true }, sequence(literal('a'), literal('b'))),
        Root: root(g),
      })) as unknown as Record<string, Combinator<unknown>>

    it.each(Object.keys(cases) as (keyof typeof cases)[])('%s', (name) => {
      for (const [trivia, options] of [[regex(/[ ]+/), {}], [documentTrivia(), SELECTED]] as const) {
        const { entries } = engines(build(cases[name], trivia), 'Root')
        expectIdentity(entries, 'x:a b', options)
        expect(outcome(entries.run!, 'x:a b', interpreterRun, options)).toMatchObject({ ok: true, unconsumedFrom: null })
      }
    })

    it('and the macro build agrees', () => {
      const out = transformMacro(`import { compose, literal, noTrivia, parser, regex, rules, sequence } from 'parseman' with { type: 'macro' }
const ws = regex(/[ ]+/)
export const parser_ = compose([rules({ trivia: ws }, g => ({
  Body: parser({ captureTrivia: true }, sequence(literal('a'), literal('b'))),
  Root: noTrivia(sequence(literal('x:'), g.Body)),
  Ambient: sequence(literal('x:'), g.Body),
}))])`, path.join(DIR, 'capture-only-scope.ts'), new Set(['parseman']))
      expect(out?.warnings).toEqual([])
      expect(out?.code).not.toMatch(/\bcompose\s*\(/)
      const grammar = evalMacroModule<Record<string, Entry>>(out!.code, 'parser_')
      expect(run(grammar.Root!, 'x:a b')).toMatchObject({ ok: true, unconsumedFrom: null })
      expect(run(grammar.Ambient!, 'x:a b')).toMatchObject({ ok: true, unconsumedFrom: null })
    })

    it('a scope that clears still clears, with or without capture', () => {
      for (const opts of [{ trivia: null }, { trivia: null, captureTrivia: true }]) {
        const grammar = rules({ trivia: regex(/[ ]+/) }, () => ({
          Root: parser(opts, sequence(literal('a'), literal('b'))),
        })) as unknown as Record<string, Combinator<unknown>>
        const { entries } = engines(grammar, 'Root')
        expectIdentity(entries, 'a b', {})
        expect(outcome(entries.run!, 'a b', interpreterRun, {})).toMatchObject({ ok: false })
      }
    })

    it('a node under one logs the gap the scope inherited', () => {
      const grammar = rules({ trivia: documentTrivia() }, () => ({
        Root: parser({ captureTrivia: true }, node('N', sequence(literal('a'), literal('b')),
          ((_c: unknown, _f: unknown, _s: unknown, _r: unknown, log: readonly number[]) => [...log]) as never)),
      })) as unknown as Record<string, Combinator<unknown>>
      const { entries } = engines(grammar, 'Root')
      expectIdentity(entries, 'a /*x*/ b')
      expect(interpreterRun(entries.run!, 'a /*x*/ b').value).not.toEqual([])
    })
  })

  it('charges a line-tracked rule no depth for the scope line tracking wraps it in', () => {
    const wrapped = (n: number) => {
      let body: Combinator<unknown> = sequence(literal('a'), literal('b'))
      for (let i = 0; i < n; i++) body = attempt(body)
      return body
    }
    // The walk stops at twelve wrappers and answers yes, so a body past the budget
    // cannot tell the two apart; a cleared scope at the bottom can.
    const cleared = (n: number) => {
      let body: Combinator<unknown> = noTrivia(literal('a'))
      for (let i = 0; i < n; i++) body = attempt(body)
      return body
    }
    expect(hasOwnTriviaBoundary(wrapped(11))).toBe(true)
    expect(hasOwnTriviaBoundary(cleared(11))).toBe(false)
    expect(hasOwnTriviaBoundary(parser({ trackLines: true }, cleared(11)))).toBe(false)
  })
})
