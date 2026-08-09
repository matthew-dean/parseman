import { describe, expect, it } from 'vitest'
import {
  dispatch, literal, makeWhen, matches, otherwise, regex, routed, run,
  sequence, startsWith, token, transform, when,
  type Combinator, type ParseContext,
} from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_DISPATCH } from '../../src/table/ops.ts'
import {
  ownTableProgram, resolveTable, type PrecompiledAssembly, type TableProgram,
} from '../../src/table/program.ts'

type RawEntry = (input: string, pos: number, ctx: ParseContext) => unknown
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function program(entry: Combinator<unknown>): TableProgram {
  return encodeTable({ Entry: entry })
}

function dispatchIp(prog: TableProgram): number {
  const ips = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_DISPATCH)
  expect(ips).toHaveLength(1)
  return ips[0]!
}

function precompiled(prog: TableProgram): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory']
  return ownTableProgram({
    ...prog,
    asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }],
  })
}

function tableEntries(prog: TableProgram): Record<string, RawEntry> {
  return {
    reference: execRules(prog).Entry! as RawEntry,
    closure: tableRules({ ...prog, asm: [] }).Entry! as RawEntry,
    emitted: tableRules(prog).Entry! as RawEntry,
    precompiled: tableRules(precompiled(prog)).Entry! as RawEntry,
  }
}

describe('table dispatch correctness', () => {
  it('restores an outer routed value when a routed branch throws', () => {
    const branch = transform(routed(), () => { throw new Error('dispatch boom') })
    const grammar = dispatch(literal('a'), when('a', branch))
    const prog = program(grammar)

    const sourceSentinel = { value: 'outer', span: { start: 7, end: 12 } }
    const sourceCtx = { trackLines: false, _routed: sourceSentinel } as ParseContext
    expect(() => grammar.parse('a', 0, sourceCtx)).toThrow('dispatch boom')
    expect(sourceCtx._routed).toBe(sourceSentinel)

    for (const [name, entry] of Object.entries(tableEntries(prog))) {
      const sentinel = { value: 'outer', span: { start: 7, end: 12 } }
      const ctx = { trackLines: false, _routed: sentinel } as ParseContext
      expect(() => entry('a', 0, ctx), name).toThrow('dispatch boom')
      expect(ctx._routed, name).toBe(sentinel)
    }

    // RED plant: delete any routed `finally` restoration in exec, closure, or
    // emitted source. The corresponding assertion above observes the routed
    // value installed by this dispatch instead of the outer sentinel.
  })

  it('keeps plain throwing arms outside the emitted routed try/finally', () => {
    const routedBoom = transform(routed(), () => { throw new Error('routed boom') })
    const plainBoom = transform(literal('!'), () => { throw new Error('plain boom') })
    const mixed = dispatch(
      regex(/[ab]/),
      when('a', routedBoom),
      otherwise(plainBoom),
    )
    const allRouted = dispatch(
      regex(/[ab]/),
      when('a', sequence(routed(), literal('!'))),
      when('b', sequence(routed(), literal('?'))),
    )
    const allPlain = dispatch(
      regex(/[ab]/),
      when('a', literal('!')),
      when('b', literal('?')),
    )
    const assertShape = (grammar: Combinator<unknown>, routedCalls: number): void => {
      const shapeProg = program(grammar)
      const source = emitAssemblySource(resolveTable(shapeProg), shapeProg, STRICT).source
      expect(source.match(/switch\(arm\)/g)).toHaveLength(1)
      expect(source.match(/try\{v=/g)?.length ?? 0).toBe(routedCalls)
      const switchBody = /switch\(arm\)\{([\s\S]*?)\n\}\nif\(v===FAIL\)/.exec(source)?.[1]
      expect(switchBody).toBeDefined()
      expect(switchBody!.match(/v=\w+\(input,(?:pos|selEnd),ctx\)/g)).toHaveLength(2)
      expect(source).not.toMatch(/DSP\[\d+\]\.routed/)
    }
    assertShape(mixed, 1)
    assertShape(allRouted, 2)
    assertShape(allPlain, 0)

    const prog = program(mixed)
    const source = emitAssemblySource(resolveTable(prog), prog, STRICT).source
    expect(source).toMatch(/case 0:\{const savedRouted=[\s\S]*finally\{ctx\._routed=savedRouted\}/)
    expect(source).toMatch(/default:v=\w+\(input,selEnd,ctx\);break/)

    // A plain branch neither overwrites nor restores a caller-owned routed
    // value, even when its reducer throws.
    for (const [name, entry] of Object.entries(tableEntries(prog))) {
      const sentinel = { value: 'outer', span: { start: 7, end: 12 } }
      const ctx = { trackLines: false, _routed: sentinel } as ParseContext
      expect(() => entry('b!', 0, ctx), name).toThrow('plain boom')
      expect(ctx._routed, name).toBe(sentinel)
    }
  })

  it('refuses every malformed dispatch arm authority before linking', () => {
    const ci = makeWhen({ caseInsensitive: true })
    const grammar = dispatch(
      token(regex(/[A-Za-z-]+/)),
      when('exact', sequence(routed(), literal('!'))),
      ci('fold', literal('?')),
      when(startsWith('pre'), literal(':')),
      when(matches(/^dash-/), literal(';')),
      otherwise(literal('.')),
    )
    const base = program(grammar)
    const ip = dispatchIp(base)
    const di = base.code[ip + 2]!
    const raw = base.dsp[di]!
    const malformedCases: readonly [string, typeof raw][] = [
      ['exact arm', { ...raw, key: ['exact'], keyArm: [99] }],
      ['folded arm', { ...raw, fold: ['fold'], foldArm: [99] }],
      ['matcher arm', {
        ...raw,
        match: raw.match.map((m, i) => i === 0 ? [m[0], m[1], m[2], 99] : m),
      }],
      ['routed arity', { ...raw, routed: raw.routed.slice(1) }],
      ['routed value', { ...raw, routed: raw.routed.map((v, i) => i === 0 ? 2 : v) }],
    ]

    for (const [kind, planted] of malformedCases) {
      const plantedDsp = base.dsp.map((spec, i) => i === di ? planted : spec)
      const malformed = ownTableProgram({
        ...base,
        dsp: plantedDsp,
        asm: [],
      })
      const validPrecompiled = precompiled(base)
      const assembly = validPrecompiled.asm![0]!
      let factoryCalls = 0
      const factory = ((...args: Parameters<PrecompiledAssembly['factory']>) => {
        factoryCalls++
        return assembly.factory(...args)
      }) as PrecompiledAssembly['factory']
      const malformedPrecompiled = ownTableProgram({
        ...validPrecompiled,
        dsp: plantedDsp,
        asm: [{ ...assembly, factory }],
      })
      expect(
        () => run(tableRules(malformedPrecompiled).Entry!, 'exact!'),
        `precompiled ${kind}`,
      )
        .toThrow(/table: malformed dispatch/)
      expect(factoryCalls, `precompiled factory ${kind}`).toBe(0)
      expect(
        () => run(tableRules(malformed).Entry!, 'exact!'),
        `closure ${kind}`,
      ).toThrow(/table: malformed dispatch/)
      expect(
        () => emitAssemblySource(resolveTable(malformed), malformed, STRICT),
        `emitter ${kind}`,
      ).toThrow(/table: malformed dispatch/)
    }

    const fallbackBase = program(dispatch(
      regex(/[ab]/),
      when('a', literal('!')),
      otherwise(sequence(routed(), literal('.'))),
    ))
    const fallbackIp = dispatchIp(fallbackBase)
    expect(fallbackBase.code[fallbackIp + 4]).toBe(1)
    const malformedCodeCases: readonly [string, (code: number[]) => void][] = [
      ['fallback routed flag', code => { code[fallbackIp + 4] = 2 }],
      ['missing dsp index', code => { code[fallbackIp + 2] = fallbackBase.dsp.length + 7 }],
    ]
    for (const [kind, mutate] of malformedCodeCases) {
      const code = [...fallbackBase.code]
      mutate(code)
      const malformed = ownTableProgram({ ...fallbackBase, code, asm: [] })
      const validPrecompiled = precompiled(fallbackBase)
      const assembly = validPrecompiled.asm![0]!
      let factoryCalls = 0
      const factory = ((...args: Parameters<PrecompiledAssembly['factory']>) => {
        factoryCalls++
        return assembly.factory(...args)
      }) as PrecompiledAssembly['factory']
      const malformedPrecompiled = ownTableProgram({
        ...validPrecompiled,
        code,
        asm: [{ ...assembly, factory }],
      })
      expect(
        () => run(tableRules(malformedPrecompiled).Entry!, 'b.'),
        `precompiled ${kind}`,
      ).toThrow(/table: malformed dispatch/)
      expect(factoryCalls, `precompiled factory ${kind}`).toBe(0)
      expect(
        () => run(tableRules(malformed).Entry!, 'b.'),
        `closure ${kind}`,
      ).toThrow(/table: malformed dispatch/)
      expect(
        () => emitAssemblySource(resolveTable(malformed), malformed, STRICT),
        `emitter ${kind}`,
      ).toThrow(/table: malformed dispatch/)
    }

    // RED plant: remove either loader's validateDispatchSpec call. The corrupt
    // arm is then linked, misroutes or throws an incidental non-contract error.
    // In particular, the precompiled case starts from a VALID factory and only
    // mutates `dsp`, so it cannot pass by re-running the emitter as validation.
  })
})
