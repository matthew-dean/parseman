import { describe, expect, it } from 'vitest'
import {
  dispatch, literal, makeWhen, matches, otherwise, regex, routed, run, sequence,
  startsWith, token, transform, when, type Combinator, type ParseContext,
} from '../../src/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_DISPATCH } from '../../src/table/ops.ts'
import { ownTableProgram, resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'

type RawEntry = (input: string, pos: number, ctx: ParseContext) => unknown
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
const program = (entry: Combinator<unknown>): TableProgram => encodeTable({ Entry: entry })

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

function exercise(prog: TableProgram, input = 'exact!'): unknown {
  return (tableRules(prog).Entry! as RawEntry)(input, 0, { trackLines: false } as ParseContext)
}

describe('table dispatch correctness', () => {
  it('restores caller routed state when a routed branch throws', () => {
    const grammar = dispatch(literal('a'), when('a', transform(routed(), () => { throw new Error('boom') })))
    const prog = program(grammar)
    const entries: Record<string, RawEntry> = {
      source: (input, pos, ctx) => grammar.parse(input, pos, ctx),
      reference: execRules(prog).Entry! as RawEntry,
      closure: tableRules({ ...prog, asm: [] }).Entry! as RawEntry,
      emitted: tableRules(prog).Entry! as RawEntry,
      precompiled: tableRules(precompiled(prog)).Entry! as RawEntry,
    }
    for (const [name, entry] of Object.entries(entries)) {
      const sentinel = { value: 'outer', span: { start: 7, end: 12 } }
      const ctx = { trackLines: false, _routed: sentinel } as ParseContext
      expect(() => entry('a', 0, ctx), name).toThrow('boom')
      expect(ctx._routed, name).toBe(sentinel)
    }
  })

  it('refuses malformed arm authorities before linking or invoking a valid factory', () => {
    const ci = makeWhen({ caseInsensitive: true })
    const base = program(dispatch(
      token(regex(/[A-Za-z-]+/)),
      when('exact', sequence(routed(), literal('!'))),
      ci('fold', literal('?')),
      when(startsWith('pre'), literal(':')),
      when(matches(/^dash-/), literal(';')),
      otherwise(literal('.')),
    ))
    const ip = dispatchIp(base)
    const di = base.code[ip + 2]!
    const raw = base.dsp[di]!
    const malformed = [
      { ...raw, key: ['exact'], keyArm: [99] },
      { ...raw, fold: ['fold'], foldArm: [99] },
      { ...raw, match: raw.match.map((m, i) => i === 0 ? [m[0], m[1], m[2], 99] as const : m) },
      { ...raw, routed: raw.routed.slice(1) },
      { ...raw, routed: raw.routed.map((v, i) => i === 0 ? 2 : v) },
    ]
    for (const spec of malformed) {
      const dsp = base.dsp.map((entry, i) => i === di ? spec : entry)
      const bad = ownTableProgram({ ...base, dsp, asm: [] })
      expect(() => exercise(bad)).toThrow(/table: malformed dispatch/)
      expect(() => emitAssemblySource(resolveTable(bad), bad, STRICT)).toThrow(/table: malformed dispatch/)

      const valid = precompiled(base)
      const assembly = valid.asm![0]!
      let calls = 0
      const factory = ((...args: Parameters<PrecompiledAssembly['factory']>) => {
        calls++
        return assembly.factory(...args)
      }) as PrecompiledAssembly['factory']
      expect(() => exercise(ownTableProgram({
        ...valid, dsp, asm: [{ ...assembly, factory }],
      }))).toThrow(/table: malformed dispatch/)
      expect(calls).toBe(0)
    }

    const fallbackBase = program(dispatch(
      regex(/[ab]/),
      when('a', literal('!')),
      otherwise(sequence(routed(), literal('.'))),
    ))
    const fallbackIp = dispatchIp(fallbackBase)
    expect(fallbackBase.code[fallbackIp + 4]).toBe(1)
    const malformedCodeCases: Array<(code: number[]) => void> = [
      code => { code[fallbackIp + 4] = 2 },
      code => { code[fallbackIp + 2] = fallbackBase.dsp.length + 1 },
    ]
    for (const mutate of malformedCodeCases) {
      const code = [...fallbackBase.code]
      mutate(code)
      const bad = ownTableProgram({ ...fallbackBase, code, asm: [] })
      expect(() => exercise(bad, 'b.')).toThrow(/table: malformed dispatch/)
      expect(() => emitAssemblySource(resolveTable(bad), bad, STRICT)).toThrow(/table: malformed dispatch/)

      const valid = precompiled(fallbackBase)
      const assembly = valid.asm![0]!
      let calls = 0
      const factory = ((...args: Parameters<PrecompiledAssembly['factory']>) => {
        calls++
        return assembly.factory(...args)
      }) as PrecompiledAssembly['factory']
      expect(() => exercise(ownTableProgram({
        ...valid, code, asm: [{ ...assembly, factory }],
      }), 'b.')).toThrow(/table: malformed dispatch/)
      expect(calls).toBe(0)
    }
  })
})
