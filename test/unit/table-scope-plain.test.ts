import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  attempt, choice, classifiedTrivia, literal, noTrivia, optional, parser, regex, rules, run, sequence,
  type Combinator,
} from '../../src/index.ts'
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

type Entry = Parameters<typeof run>[0]
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
    asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }],
  }
}

function legacyPrecompiled(prog: TableProgram): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const compactCall = 'return commitTriviaScan(scanTriviaCompact(input,cur,ctx))'
  const legacySource = emitted.source.replaceAll(
    compactCall,
    'return (()=>{const scan=scanTrivia(input,cur,ctx);scan.commit();return scan.end})()',
  )
  expect(legacySource).not.toContain('scanTriviaCompact')
  expect(legacySource).not.toContain('commitTriviaScan')
  expect(legacySource).not.toBe(emitted.source)
  // The old factory predates all three appended helpers: compact trivia commit,
  // compact trivia scan, and selected lexical bodies. New runtimes may append
  // positional inputs, but must never insert one into this historical prefix.
  const legacyParams = EMITTED_PARAMS.slice(0, -3)
  const factory = new Function(...legacyParams, legacySource) as PrecompiledAssembly['factory']
  return {
    ...prog,
    asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }],
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
      interpreter: grammar[entry]! as Entry,
      emitted: tableRules(prog)[entry]! as Entry,
      closure: tableRules({ ...prog, asm: [] })[entry]! as Entry,
      reference: execRules(prog)[entry]! as Entry,
      precompiled: tableRules(precompiled(prog))[entry]! as Entry,
      folded: tableVariants(foldPrograms({ base: { ...prog, asm: [] } }, 'base'), 'base')[entry]! as Entry,
    },
  }
}

function outcome(entry: Entry, input: string): unknown {
  const result = run(entry, input, SELECTED)
  return {
    ok: result.ok,
    value: result.value,
    span: result.span,
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

function expectIdentity(entries: Record<string, Entry>, input: string): void {
  const expected = outcome(entries.interpreter!, input)
  for (const [name, entry] of Object.entries(entries)) {
    expect(outcome(entry, input), `${name}: ${JSON.stringify(input)}`).toEqual(expected)
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
  it('executes compact and legacy precompiled classified-trivia factories', () => {
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

    // A factory compiled against the previous positional ABI still calls
    // `scanTrivia(...).commit()`. The new helpers are appended, never inserted,
    // and the legacy helper remains object-shaped.
    expect(outcome(tableRules(legacyPrecompiled(prog)).Doc! as Entry, input)).toEqual(expected)
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
})
