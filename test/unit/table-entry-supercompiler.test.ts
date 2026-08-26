import { describe, expect, it } from 'vitest'
import { parseSync } from 'oxc-parser'
import {
  choice, classifiedTrivia, completionsAt, dispatch, literal, many, node, parser, regex,
  routed, run, sequence, transform, when, type Combinator, type ParseContext,
} from '../../src/index.ts'
import { supercompileEmittedAssembly, supercompileEntryAssembly } from '../../src/plugin/entry-supercompiler.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'

type Entry = Parameters<typeof run>[0]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function grammar(): Record<string, Combinator<unknown>> {
  const trivia = classifiedTrivia({
    whitespace: regex(/[ \t\r\n]+/),
    comment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
  })
  const item = choice(
    node('Word', sequence(regex(/[a-z]+/), literal(':'))),
    node('Number', sequence(regex(/[0-9]+/), literal(';'))),
  )
  return {
    Entry: node('Document', parser(
      { trivia, captureTrivia: true },
      sequence(literal('{'), many(item), literal('}')),
    )),
  }
}

function installed(
  prog: TableProgram,
  source: string,
  plan: PrecompiledAssembly['plan'],
  key = 0,
  reached: readonly number[] = [],
): Entry {
  const factory = new Function(...EMITTED_PARAMS, source) as PrecompiledAssembly['factory']
  return tableRules({
    ...prog,
    asm: [{ key, factory, plan, reached }],
  }).Entry! as Entry
}

function result(entry: Entry, input: string): unknown {
  const r = run(entry, input)
  return {
    ok: r.ok,
    value: r.value,
    span: r.span,
    expected: r.expected,
    errors: r.errors,
    unconsumedFrom: r.unconsumedFrom,
    rootTrivia: r.rootTrivia,
  }
}

function plantRootFailure(source: string, ip: number): string {
  const prefix = 'function __plant__(){\n'
  const parsed = parseSync('entry-supercompiler-red.js', prefix + source + '\n}')
  expect(parsed.errors).toEqual([])
  const program = parsed.program as unknown as { body: Array<Record<string, unknown>> }
  const wrapper = program.body[0]!
  const statements = ((wrapper.body as { body: Array<Record<string, unknown>> }).body)
  const root = statements.find(statement => {
    const id = statement.id as { name?: string } | undefined
    return statement.type === 'FunctionDeclaration' && id?.name === `_pf${ip}`
  })!
  const body = root.body as { start: number; end: number }
  const start = body.start - prefix.length + 1
  const end = body.end - prefix.length - 1
  return source.slice(0, start) + 'return FAIL' + source.slice(end)
}

function plantedShape(source: string, prog: TableProgram, emitted: ReturnType<typeof emitAssemblySource>) {
  return supercompileEmittedAssembly(prog, STRICT, [], { ...emitted, source })
}

describe('static Entry/SCC supercompiler experiment', () => {
  it('joins nested NODE/REPV capture control and preserves every result facet', () => {
    const prog = encodeTable(grammar())
    const baseline = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const candidate = supercompileEntryAssembly(prog, STRICT)
    expect(candidate.supercompile).toMatchObject({ activated: true })
    expect(candidate.supercompile.functionsAfter).toBeLessThan(candidate.supercompile.functionsBefore)
    expect(candidate.supercompile.pieceCallsAfter).toBeLessThan(candidate.supercompile.pieceCallsBefore)
    expect(candidate.source.length).toBeLessThanOrEqual(Math.ceil(baseline.source.length * 1.05))
    expect(candidate.supercompile.largestRegionSource).toBeLessThanOrEqual(180_000)

    const baseEntry = installed(prog, baseline.source, baseline.plan)
    const candidateEntry = installed(prog, candidate.source, candidate.plan)
    for (const input of ['{}', '{foo: 12;}', '{ /*x*/ foo: 12; }', '{foo:', '{x:}tail']) {
      expect(result(candidateEntry, input), input).toEqual(result(baseEntry, input))
    }

    // Deliberate RED: structurally replace only the candidate Entry body with
    // failure. The same parity predicate above must observe the planted defect.
    const poisonedSource = plantRootFailure(candidate.source, prog.rules.Entry!)
    const poisoned = installed(prog, poisonedSource, candidate.plan)
    expect(result(poisoned, '{foo:}')).not.toEqual(result(baseEntry, '{foo:}'))
  })

  it('preserves try/finally restoration when an in-region routed builder throws', () => {
    const branch = transform(routed(), () => { throw new Error('joined dispatch boom') })
    const prog = encodeTable({ Entry: dispatch(literal('a'), when('a', branch)) })
    const baseline = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const candidate = supercompileEntryAssembly(prog, STRICT)
    expect(candidate.supercompile.activated).toBe(true)
    expect(candidate.source).toMatch(/try\{[\s\S]*_z\d+:[\s\S]*finally\{ctx\._routed=savedRouted\}/)

    for (const [name, entry] of Object.entries({
      baseline: installed(prog, baseline.source, baseline.plan),
      candidate: installed(prog, candidate.source, candidate.plan),
    })) {
      const sentinel = { value: 'outer', span: { start: 7, end: 12 } }
      const ctx = { trackLines: false, _routed: sentinel } as ParseContext
      expect(() => (entry as (input: string, pos: number, ctx: ParseContext) => unknown)('a', 0, ctx), name)
        .toThrow('joined dispatch boom')
      expect(ctx._routed, name).toBe(sentinel)
    }
  })

  it('uses Unicode-safe ranges and preserves value-referenced piece barriers', () => {
    const prog = encodeTable({
      Entry: node('Døcument', sequence(literal('é'), many(choice(regex(/[λ]/), literal('終'))))),
    })
    const privateIp = [...reachableIps(prog)].find(ip => ip !== prog.rules.Entry)!
    const baseline = emitAssemblySource(resolveTable(prog), prog, STRICT, [privateIp], true)
    const candidate = supercompileEntryAssembly(prog, STRICT, [privateIp])
    expect(parseSync('unicode-candidate.js', `function f(){${candidate.source}}`).errors).toEqual([])
    expect(candidate.source).toContain(`function _pf${privateIp}`)
    expect(candidate.source).toContain(`${privateIp}:_pf${privateIp}`)
    const baseEntry = installed(prog, baseline.source, baseline.plan, 0, [...baseline.reached])
    const candidateEntry = installed(prog, candidate.source, candidate.plan, 0, [...candidate.reached])
    for (const input of ['é', 'éλλ終', 'é終x', 'λ']) {
      expect(result(candidateEntry, input), input).toEqual(result(baseEntry, input))
    }
  })

  it('fails closed when a direct-looking assignment is nested in control flow', () => {
    const prog = encodeTable({ Entry: sequence(literal('a'), literal('b')) })
    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const entry = prog.rules.Entry!
    const child = [...reachableIps(prog)].find(ip => ip !== entry)!
    const source = [
      `function _pf${child}(input,pos,ctx){return pos}`,
      `function _pf${entry}(input,pos,ctx){let v;if(ctx.flag&&((v=_pf${child}(input,pos,ctx))!==FAIL))return v;return FAIL}`,
      `const _r_Entry=_pf${entry}`,
    ].join('\n')
    const candidate = plantedShape(source, prog, emitted)
    expect(candidate.supercompile.functionsAfter).toBe(2)
    expect(candidate.source).toContain(`function _pf${child}`)
  })

  it('fails closed for a call initializer after another declarator', () => {
    const prog = encodeTable({ Entry: sequence(literal('a'), literal('b')) })
    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const entry = prog.rules.Entry!
    const child = [...reachableIps(prog)].find(ip => ip !== entry)!
    const source = [
      `function _pf${child}(input,pos,ctx){return pos}`,
      `function _pf${entry}(input,pos,ctx){let before=ctx.touch(),v=_pf${child}(input,pos,ctx);return before+v}`,
      `const _r_Entry=_pf${entry}`,
    ].join('\n')
    const candidate = plantedShape(source, prog, emitted)
    expect(candidate.supercompile.functionsAfter).toBe(2)
    expect(candidate.source).toContain(`function _pf${child}`)
  })

  it('evaluates call position once and runs finally across joined nested exits', () => {
    const prog = encodeTable({ Entry: sequence(literal('a'), literal('b')) })
    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const entry = prog.rules.Entry!
    const child = [...reachableIps(prog)].find(ip => ip !== entry)!
    const source = [
      `/*${'shape-padding'.repeat(40)}*/`,
      `function _pf${child}(input,pos,ctx){try{while(true){switch(ctx.mode){case 0:return pos+1;default:return FAIL}}}finally{ctx.restored++}}`,
      `function _pf${entry}(input,pos,ctx){return _pf${child}(input,ctx.next(),ctx)}`,
      `return _pf${entry}`,
    ].join('\n')
    const candidate = plantedShape(source, prog, emitted)
    expect(candidate.supercompile.functionsAfter).toBe(1)
    expect(candidate.source.match(/ctx\.next\(\)/g)).toHaveLength(1)
    const runJoined = new Function('FAIL', candidate.source)(Symbol('FAIL')) as (
      input: string,
      pos: number,
      ctx: { mode: number; restored: number; next(): number },
    ) => number
    let positions = 0
    const ctx = { mode: 0, restored: 0, next: () => { positions++; return 4 } }
    expect(runJoined('', 0, ctx)).toBe(5)
    expect(positions).toBe(1)
    expect(ctx.restored).toBe(1)
  })

  it.each([
    ['arguments', 'return arguments[1]'],
    ['this', 'return this'],
    ['new.target', 'return new.target'],
    ['var', 'var x=pos;return x'],
  ])('fails closed when an absorbed body reads function-local %s semantics', (_name, childBody) => {
    const prog = encodeTable({ Entry: sequence(literal('a'), literal('b')) })
    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const entry = prog.rules.Entry!
    const child = [...reachableIps(prog)].find(ip => ip !== entry)!
    const source = [
      `function _pf${child}(input,pos,ctx){${childBody}}`,
      `function _pf${entry}(input,pos,ctx){return _pf${child}(input,pos,ctx)}`,
      `return _pf${entry}`,
    ].join('\n')
    const candidate = plantedShape(source, prog, emitted)
    expect(candidate.supercompile.functionsAfter).toBe(2)
    expect(candidate.supercompile.barriers).toMatchObject({ scope: 1 })
    expect(candidate.source).toContain(`function _pf${child}`)
  })

  it.each([
    ['async', (name: string) => `async function ${name}(input,pos,ctx){return pos}`],
    ['generator', (name: string) => `function* ${name}(input,pos,ctx){yield pos}`],
  ])('fails closed for an %s piece body', (_name, declaration) => {
    const prog = encodeTable({ Entry: sequence(literal('a'), literal('b')) })
    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const entry = prog.rules.Entry!
    const child = [...reachableIps(prog)].find(ip => ip !== entry)!
    const source = [
      declaration(`_pf${child}`),
      `function _pf${entry}(input,pos,ctx){return _pf${child}(input,pos,ctx)}`,
      `return _pf${entry}`,
    ].join('\n')
    const candidate = plantedShape(source, prog, emitted)
    expect(candidate.supercompile.functionsAfter).toBe(2)
    expect(candidate.supercompile.barriers).toMatchObject({ scope: 1 })
  })

  it('fails closed for a callee without the canonical input/pos/ctx signature', () => {
    const prog = encodeTable({ Entry: sequence(literal('a'), literal('b')) })
    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const entry = prog.rules.Entry!
    const child = [...reachableIps(prog)].find(ip => ip !== entry)!
    const source = [
      `function _pf${child}(input,p,ctx){return p}`,
      `function _pf${entry}(input,pos,ctx){return _pf${child}(input,pos,ctx)}`,
      `return _pf${entry}`,
    ].join('\n')
    const candidate = plantedShape(source, prog, emitted)
    expect(candidate.supercompile.functionsAfter).toBe(2)
    expect(candidate.supercompile.barriers).toMatchObject({ shape: 1 })
    expect(candidate.source).toContain(`function _pf${child}`)
  })

  it('uses Unicode-safe fabricated ranges before and inside an absorbed body', () => {
    const prog = encodeTable({ Entry: sequence(literal('a'), literal('b')) })
    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const entry = prog.rules.Entry!
    const child = [...reachableIps(prog)].find(ip => ip !== entry)!
    const source = [
      `const before='😀λ終${'é'.repeat(300)}'`,
      `function _pf${child}(input,pos,ctx){const inside='雪😀';return inside+pos}`,
      `function _pf${entry}(input,pos,ctx){return _pf${child}(input,pos,ctx)}`,
      `return _pf${entry}`,
    ].join('\n')
    const candidate = plantedShape(source, prog, emitted)
    expect(candidate.supercompile.functionsAfter).toBe(1)
    expect(parseSync('fabricated-unicode-candidate.js', `function f(){${candidate.source}}`).errors).toEqual([])
    const runJoined = new Function('FAIL', candidate.source)(Symbol('FAIL')) as (
      input: string, pos: number, ctx: unknown,
    ) => string
    expect(runJoined('', 7, {})).toBe('雪😀7')
  })

  it('returns the canonical assembly when a candidate crosses the 5% source cap', () => {
    const prog = encodeTable({ Entry: sequence(literal('a'), literal('b')) })
    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT, [], true)
    const entry = prog.rules.Entry!
    const child = [...reachableIps(prog)].find(ip => ip !== entry)!
    const source = [
      `function _pf${child}(input,pos,ctx){try{while(true){switch(ctx.mode){case 0:return pos+1;default:return FAIL}}}finally{ctx.restored++}}`,
      `function _pf${entry}(input,pos,ctx){return _pf${child}(input,ctx.next(),ctx)}`,
      `return _pf${entry}`,
    ].join('\n')
    const candidate = plantedShape(source, prog, emitted)
    expect(candidate.supercompile).toMatchObject({
      activated: false,
      reason: expect.stringContaining('5% total source cap'),
    })
    expect(candidate.source).toBe(source)
  })

  it('preserves probe completions and fails closed for coverage assemblies', () => {
    const prog = encodeTable(grammar())
    const probe = { ...STRICT, probe: true }
    const baseline = emitAssemblySource(resolveTable(prog), prog, probe, [], true)
    const candidate = supercompileEntryAssembly(prog, probe)
    const baseEntry = installed(prog, baseline.source, baseline.plan, cfgKey(probe), [...baseline.reached])
    const candidateEntry = installed(prog, candidate.source, candidate.plan, cfgKey(probe), [...candidate.reached])
    const authored = grammar().Entry!
    const baseTarget = { ...authored, parse: baseEntry as Combinator<unknown>['parse'] }
    const candidateTarget = { ...authored, parse: candidateEntry as Combinator<unknown>['parse'] }
    for (const [input, offset] of [['{foo', 4], ['{12', 3], ['{', 1]] as const) {
      expect(completionsAt(candidateTarget, input, offset).slice().sort())
        .toEqual(completionsAt(baseTarget, input, offset).slice().sort())
    }
    const coverage = { ...STRICT, coverage: true }
    expect(() => emitAssemblySource(resolveTable(prog), prog, coverage, [], true)).toThrow('coverage assembly')
    expect(() => supercompileEntryAssembly(prog, coverage)).toThrow('coverage assembly')
  })
})
