import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { choice, dispatch, literal, matches, otherwise, regex, routed, sequence, token, transform, when } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import {
  ownTableProgram, resolveTable, type PrecompiledAssembly, type TableProgram, type TokenPlanWire,
} from '../../src/table/program.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE, OP_DISPATCH, OP_RX, OP_TOKEN } from '../../src/table/ops.ts'
import { run } from '../../src/functional/run.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import type { ParseContext } from '../../src/types.ts'

const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
const DIR = path.dirname(fileURLToPath(import.meta.url))
const TABLE_RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/index.ts')).href

function precompiled(prog: TableProgram): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory']
  return { ...prog, asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }] }
}

async function moduleRules(prog: TableProgram): Promise<Record<string, (input: string, pos: number, ctx: ParseContext) => unknown>> {
  const source = emitTableModule(prog, {
    name: 'grammar', runtime: TABLE_RUNTIME, runtimeRef: 'tableRules', fnSources: prog.fns.map(fn => String(fn)),
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-token-stream-module-'))
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const file = path.join(dir, 'grammar.ts')
  writeFileSync(file, source)
  const loaded = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
    grammar: Record<string, (input: string, pos: number, ctx: ParseContext) => unknown>
  }
  return loaded.grammar
}

function assemblyShape(prog: TableProgram, cfg = STRICT): {
  readonly maps: number; readonly sets: number; readonly begin: string; readonly finish: string
} {
  const closureProg = { ...prog, asm: [] }
  const resolved = resolveTable(closureProg)
  const RealMap = globalThis.Map, RealSet = globalThis.Set
  let maps = 0, sets = 0
  const CountingMap = new Proxy(RealMap, {
    construct(target, args, newTarget) { maps++; return Reflect.construct(target, args, newTarget) },
  })
  const CountingSet = new Proxy(RealSet, {
    construct(target, args, newTarget) { sets++; return Reflect.construct(target, args, newTarget) },
  })
  Object.defineProperty(globalThis, 'Map', { configurable: true, writable: true, value: CountingMap })
  Object.defineProperty(globalThis, 'Set', { configurable: true, writable: true, value: CountingSet })
  try {
    const asm = assemble(resolved, closureProg, cfg)
    return { maps, sets, begin: String(asm.begin), finish: String(asm.finish) }
  } finally {
    Object.defineProperty(globalThis, 'Map', { configurable: true, writable: true, value: RealMap })
    Object.defineProperty(globalThis, 'Set', { configurable: true, writable: true, value: RealSet })
  }
}

function manualPlan(native = false): { readonly parser: ReturnType<typeof dispatch>; readonly prog: TableProgram } {
  const selector = token(native ? regex(/([a-z])\1+/) : regex(/[a-z]+/))
  const exact = native ? 'ff' : 'foo'
  const parser = dispatch(selector, when(exact, literal('!')), otherwise(literal('?')))
  const raw = encodeTable({ Entry: parser })
  const sites = [...reachableIps(raw)]
  const dispatchIp = sites.find(ip => raw.code[ip] === OP_DISPATCH)!
  const tokenIp = raw.code[dispatchIp + 1]!
  const childIp = raw.code[tokenIp + 1]!
  expect(raw.code[tokenIp]).toBe(OP_TOKEN)
  expect(raw.code[childIp]).toBe(OP_RX)
  const regexK = raw.code[childIp + 1]!
  const exactK = raw.k.length
  const family = 3
  const exactId = 4, fallbackId = 5
  const plan: TokenPlanWire = {
    recognizerOffsets: [0],
    recognizerData: [2, 3, regexK],
    outcomeOffsets: [0, 5],
    outcomeData: [exactId, family, 0, exactK, 0, fallbackId, family, 4],
    tokenSites: [tokenIp, family],
    sites: [raw.code[dispatchIp + 2]!, family, 0, 2],
    routes: [0, 0, 0, 1, -1, 2, 1, 1],
    accepted: [exactId, fallbackId],
  }
  return { parser, prog: ownTableProgram({ ...raw, k: [...raw.k, exact], tokenPlan: plan }) }
}

function unsupportedPlan(): {
  readonly parser: ReturnType<typeof dispatch>
  readonly planned: TableProgram
  readonly injected: TableProgram
} {
  const parser = dispatch(
    token(regex(/[a-z]+/)),
    when(matches(/^a.+z$/), literal('!')),
    otherwise(literal('?')),
  )
  const planned = encodeTable({ Entry: parser })
  const base = planned.tokenPlan!
  expect(base.sites).toEqual([])
  const dispatchIp = [...reachableIps(planned)].find(ip => planned.code[ip] === OP_DISPATCH)!
  const family = base.tokenSites[1]!
  let unsupportedId = -1, fallbackId = -1
  for (const at of base.outcomeOffsets) {
    const kind = base.outcomeData[at + 2]!
    if (kind === 3) unsupportedId = base.outcomeData[at]!
    if (kind === 4) fallbackId = base.outcomeData[at]!
  }
  expect(unsupportedId).toBeGreaterThan(0)
  expect(fallbackId).toBeGreaterThan(0)
  const tokenPlan: TokenPlanWire = {
    ...base,
    sites: [planned.code[dispatchIp + 2]!, family, 0, 2],
    routes: [0, 1, 0, 1, -1, 2, 1, 1],
    accepted: [unsupportedId, fallbackId],
  }
  return { parser, planned, injected: ownTableProgram({ ...planned, tokenPlan }) }
}

function countedChoicePlan(): {
  readonly parser: ReturnType<typeof choice>
  readonly prog: TableProgram
  readonly calls: () => number
} {
  const selector = token(regex(/([a-z])\1+/))
  const later = token(regex(/([a-z])\1+/))
  const parser = choice(
    transform(dispatch(selector, when('ff', literal('!'))), value => value),
    later,
    literal('!'),
  )
  const raw = encodeTable({ Entry: parser })
  const choiceIp = [...reachableIps(raw)].find(ip => raw.code[ip] === OP_CHOICE)!
  const xformIp = raw.code[choiceIp + 4]!
  const dispatchIp = raw.code[xformIp + 2]!
  const dspIndex = raw.code[dispatchIp + 2]!
  const plan = raw.tokenPlan!
  let siteIndex = -1
  for (let i = 0; i < plan.sites.length; i += 4) if (plan.sites[i] === dspIndex) siteIndex = i / 4
  expect(siteIndex).toBeGreaterThanOrEqual(0)
  const tokenPlan = { ...plan, choiceSites: [choiceIp, 0, siteIndex] }
  let calls = 0
  const constants = raw.k.map(value => {
    if (!(value instanceof RegExp)) return value
    const copy = new RegExp(value.source, `${value.flags.replace(/[gy]/g, '')}y`)
    const exec = copy.exec
    copy.exec = function (input: string) { calls++; return exec.call(this, input) }
    return copy
  })
  return { parser, prog: ownTableProgram({ ...raw, k: constants, tokenPlan }), calls: () => calls }
}

function earlierChoicePlan(): { readonly prog: TableProgram; readonly calls: () => number } {
  const selector = token(regex(/([a-z])\1+/))
  const parser = choice(
    literal('bb'),
    transform(dispatch(selector, when('ff', literal('!'))), value => value),
    token(regex(/([a-z])\1+/)),
  )
  const raw = encodeTable({ Entry: parser })
  expect(raw.tokenPlan?.choiceSites?.length).toBe(3)
  let calls = 0
  const constants = raw.k.map(value => {
    if (!(value instanceof RegExp)) return value
    const copy = new RegExp(value.source, `${value.flags.replace(/[gy]/g, '')}y`)
    const exec = copy.exec
    copy.exec = function (input: string) { calls++; return exec.call(this, input) }
    return copy
  })
  return { prog: ownTableProgram({ ...raw, k: constants }), calls: () => calls }
}

describe('table token stream runtime', () => {
  it('routes one atomic range and preserves canonical miss diagnostics', () => {
    const { parser, prog } = manualPlan()
    const closure = tableRules({ ...prog, asm: [] }).Entry!
    const emitted = tableRules(prog).Entry!
    for (const input of ['foo!', 'bar?', '1']) {
      const source = run(parser, input)
      for (const actual of [run(closure, input), run(emitted, input)]) {
        expect(actual).toMatchObject({
          ok: source.ok,
          value: source.value,
          span: source.span,
          expected: source.expected,
          unconsumedFrom: source.unconsumedFrom,
        })
      }
    }
    expect(run(closure, 'foo!')).toMatchObject({ ok: true, unconsumedFrom: null })
    expect(run(closure, 'bar?')).toMatchObject({ ok: true, unconsumedFrom: null })
  })

  it('recognizes once on success, twice on miss, and releases the source at finish', () => {
    for (const mode of ['closure', 'emitted'] as const) {
      const { prog } = manualPlan(true)
      const re = prog.k.find(value => value instanceof RegExp && value.sticky) as RegExp
      const original = re.exec
      let calls = 0
      re.exec = function (input: string) { calls++; return original.call(this, input) }
      const entry = tableRules(mode === 'closure' ? { ...prog, asm: [] } : prog).Entry!

      expect(run(entry, 'ff!').ok, mode).toBe(true)
      expect(calls, `${mode} success scans`).toBe(1)
      expect(run(entry, '1').ok, mode).toBe(false)
      expect(calls, `${mode} miss scans`).toBe(3)
      expect(run(entry, 'ff!').ok, mode).toBe(true)
      expect(calls, `${mode} fresh begin rescans`).toBe(4)
    }
  })

  it('has a behavior-bearing route-wire RED plant', () => {
    const { parser, prog } = manualPlan()
    const routes = [...prog.tokenPlan!.routes]
    routes[0] = -1
    const planted = ownTableProgram({ ...prog, tokenPlan: { ...prog.tokenPlan!, routes } })
    const authority = run(parser, 'foo!')
    expect(authority.ok).toBe(true)
    for (const entry of [tableRules({ ...planted, asm: [] }).Entry!, tableRules(planted).Entry!]) {
      expect(run(entry, 'foo!').ok).toBe(false)
    }
  })

  it('restores a pending range across reentry and releases it after outer finish', () => {
    const selector = token(regex(/([a-z])\1+/))
    const grammar = {
      Selector: selector,
      Dispatch: dispatch(selector, when('ff', literal('!')), otherwise(literal('?'))),
    }
    const raw = encodeTable(grammar)
    const tokenIp = raw.tokenPlan!.tokenSites[0]!
    const childIp = raw.code[tokenIp + 1]!
    const childK = raw.code[childIp + 1]!
    const recognizerK = raw.tokenPlan!.recognizerData[raw.tokenPlan!.recognizerOffsets[0]! + 2]!
    const re = /([a-z])\1+/y
    const original = re.exec
    let calls = 0
    re.exec = function (input: string) { calls++; return original.call(this, input) }
    const constants = [...raw.k]
    constants[childK] = re
    constants[recognizerK] = re
    const prog = ownTableProgram({ ...raw, k: constants, asm: [] })
    const asm = assemble(resolveTable(prog), prog, {
      hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false,
    })
    const outer = createParseContext()
    asm.begin(outer)
    expect(asm.pieces.Dispatch!('ff!', 0, outer)).not.toMatchObject({ ok: false })
    expect(calls).toBe(1)

    const inner = createParseContext()
    asm.begin(inner)
    expect(asm.pieces.Dispatch!('bb?', 0, inner)).not.toMatchObject({ ok: false })
    expect(calls).toBe(2)
    asm.finish()

    expect(asm.pieces.Selector!('ff!', 0, outer)).toBe('ff')
    expect(calls, 'outer frame restored its pending range').toBe(2)
    asm.finish()

    asm.begin(outer)
    expect(asm.pieces.Selector!('ff!', 0, outer)).toBe('ff')
    expect(calls, 'outer finish released the source and forced a fresh scan').toBe(3)
    asm.finish()
  })

  it('publishes selector end and CST leaf before a hot no-route failure', () => {
    const selector = token(regex(/[a-z]+/))
    const parser = dispatch(selector, when('foo', literal('!')))
    const prog = encodeTable({ Entry: parser })
    const sourceCtx = createParseContext()
    sourceCtx._cstLeaves = []
    const source = parser.parse('bar', 0, sourceCtx)
    expect(source).toMatchObject({ ok: false, span: { start: 3 } })
    expect(sourceCtx._cstLeaves).toEqual([{ _tag: 'leaf', value: 'bar', span: { start: 0, end: 3 } }])

    for (const entry of [tableRules({ ...prog, asm: [] }).Entry!, tableRules(prog).Entry!]) {
      const ctx = createParseContext()
      ctx._cstLeaves = []
      const result = entry('bar', 0, ctx)
      expect(result).toMatchObject({ ok: false, span: { start: 3 } })
      expect(ctx._cstLeaves).toEqual(sourceCtx._cstLeaves)
    }
  })

  it('declines an unsupported outcome site without cursor source or behavior', () => {
    const { parser, planned, injected } = unsupportedPlan()
    expect(planned.tokenPlan?.routes).toEqual([])
    expect(planned.tokenPlan?.accepted).toEqual([])
    const emitted = emitAssemblySource(resolveTable(injected), injected, {
      hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false,
    }).source
    expect(emitted).not.toContain('_pfTokInput')
    expect(emitted).not.toContain('_tokRecognize')
    for (const input of ['abz!', 'abc?']) {
      const source = run(parser, input)
      for (const entry of [tableRules({ ...injected, asm: [] }).Entry!, tableRules(injected).Entry!]) {
        expect(run(entry, input)).toMatchObject({
          ok: source.ok, value: source.value, expected: source.expected, unconsumedFrom: source.unconsumedFrom,
        })
      }
    }
  })

  it('keeps inactive closure assemblies on the exact legacy allocation and boundary shape', () => {
    const unsupported = unsupportedPlan().injected
    const { tokenPlan: _unsupportedPlan, ...unsupportedNoPlanData } = unsupported
    const unsupportedNoPlan = ownTableProgram(unsupportedNoPlanData)
    const active = manualPlan().prog
    const { tokenPlan: _activePlan, ...activeNoPlanData } = active
    const activeNoPlan = ownTableProgram(activeNoPlanData)

    const unsupportedShape = assemblyShape(unsupported)
    expect(unsupportedShape).toEqual(assemblyShape(unsupportedNoPlan))
    const activeShape = assemblyShape(active)
    const legacyShape = assemblyShape(activeNoPlan)
    expect(activeShape.maps).toBeGreaterThan(legacyShape.maps)
    expect(activeShape.sets).toBeGreaterThan(legacyShape.sets)
    expect(activeShape.begin).not.toBe(legacyShape.begin)
    expect(activeShape.finish).not.toBe(legacyShape.finish)

    for (const cold of [
      { ...STRICT, probe: true },
      { ...STRICT, coverage: true },
      { ...STRICT, tolerant: true },
      { ...STRICT, trackLines: true },
    ]) expect(assemblyShape(active, cold)).toEqual(assemblyShape(activeNoPlan, cold))
  })

  it('does not suspend a token frame before a throwing build getter completes', () => {
    const { prog } = manualPlan()
    const closureProg = { ...prog, asm: [] }
    const asm = assemble(resolveTable(closureProg), closureProg, STRICT)
    const bad = createParseContext()
    Object.defineProperty(bad, 'build', { configurable: true, get(): never { throw new Error('build getter') } })
    expect(() => asm.begin(bad)).toThrow('build getter')
    const beginSource = String(asm.begin)
    expect(beginSource.indexOf('beginLegacy(ctx)')).toBeLessThan(beginSource.indexOf('tokenRuntime.begin'))

    const outer = createParseContext(), inner = createParseContext()
    asm.begin(outer)
    expect(asm.pieces.Entry!('foo!', 0, outer)).not.toBe(false)
    asm.begin(inner)
    expect(asm.pieces.Entry!('bar?', 0, inner)).not.toBe(false)
    asm.finish()
    expect(asm.pieces.Entry!('foo!', 0, outer)).not.toBe(false)
    asm.finish()
    expect(() => asm.finish()).toThrow('underflow')
  })

  it('reuses one family range across PEG rollback but never across a different family', () => {
    function counted(equalFamily: boolean): { readonly prog: TableProgram; readonly calls: () => number } {
      const first = token(regex(/([a-z])\1+/))
      const later = equalFamily ? token(regex(/([a-z])\1+/)) : token(regex(/(?:[a-z]){2,}/))
      const raw = encodeTable({ Entry: choice(dispatch(first, when('ff', literal('!'))), later) })
      let calls = 0
      const constants = raw.k.map(value => {
        if (!(value instanceof RegExp)) return value
        const copy = new RegExp(value.source, `${value.flags.replace(/[gy]/g, '')}y`)
        const exec = copy.exec
        copy.exec = function (input: string) { calls++; return exec.call(this, input) }
        return copy
      })
      return { prog: ownTableProgram({ ...raw, k: constants }), calls: () => calls }
    }
    for (const mode of ['closure', 'emitted', 'precompiled'] as const) {
      for (const equal of [true, false]) {
        const counter = counted(equal)
        const prog = mode === 'closure' ? { ...counter.prog, asm: [] }
          : mode === 'precompiled' ? precompiled(counter.prog) : counter.prog
        expect(run(tableRules(prog).Entry!, 'bb')).toMatchObject({ ok: true, unconsumedFrom: null })
        expect(counter.calls(), `${mode} ${equal ? 'same' : 'different'} family`).toBe(equal ? 1 : 2)
      }
    }
  })

  it('predecides only a gate-admitted choice arm and retains its range across rollback', () => {
    for (const mode of ['closure', 'emitted', 'precompiled'] as const) {
      for (const [input, scans] of [['bb', 1], ['ff!', 1], ['!', 0]] as const) {
        const counted = countedChoicePlan()
        const prog = mode === 'closure' ? { ...counted.prog, asm: [] }
          : mode === 'precompiled' ? precompiled(counted.prog) : counted.prog
        const entry = tableRules(prog).Entry!
        const actual = run(entry, input)
        expect(actual, `${mode} ${input}`).toMatchObject({
          ok: true, value: run(counted.parser, input).value, unconsumedFrom: null,
        })
        expect(counted.calls(), `${mode} ${input} scans`).toBe(scans)
        if (input === 'bb') {
          const ctx = createParseContext()
          const leaves: NonNullable<ParseContext['_cstLeaves']> = []
          const push = leaves.push
          let pushes = 0
          leaves.push = function (...items) { pushes += items.length; return push.apply(this, items) }
          ctx._cstLeaves = leaves
          expect(entry(input, 0, ctx)).not.toBe(false)
          expect(pushes, `${mode} skipped-arm transient selector leaves`).toBe(1)
        }
      }
    }
  })

  it('does not classify a related arm before an earlier arm succeeds', () => {
    for (const mode of ['closure', 'emitted', 'precompiled'] as const) {
      const counted = earlierChoicePlan()
      const prog = mode === 'closure' ? { ...counted.prog, asm: [] }
        : mode === 'precompiled' ? precompiled(counted.prog) : counted.prog
      expect(run(tableRules(prog).Entry!, 'bb')).toMatchObject({ ok: true, unconsumedFrom: null })
      expect(counted.calls(), `${mode} scans`).toBe(0)
    }
  })

  it('defensively ignores an exclusive outer-choice relation', () => {
    const selector = token(regex(/([a-z])\1+/))
    const parser = choice(
      transform(dispatch(selector, when('ff', literal('!'))), value => value),
      literal('!'),
    )
    const raw = encodeTable({ Entry: parser })
    expect(raw.tokenPlan?.choiceSites).toBeUndefined()
    const choiceIp = [...reachableIps(raw)].find(ip => raw.code[ip] === OP_CHOICE)!
    const dispatchIp = raw.code[raw.code[choiceIp + 4]! + 2]!
    const dspIndex = raw.code[dispatchIp + 2]!
    let siteIndex = -1
    for (let i = 0; i < raw.tokenPlan!.sites.length; i += 4) {
      if (raw.tokenPlan!.sites[i] === dspIndex) siteIndex = i / 4
    }
    expect(siteIndex).toBeGreaterThanOrEqual(0)
    const planted = ownTableProgram({
      ...raw,
      tokenPlan: { ...raw.tokenPlan!, choiceSites: [choiceIp, 0, siteIndex] },
    })
    for (const entry of [tableRules({ ...planted, asm: [] }).Entry!, tableRules(planted).Entry!]) {
      expect(run(entry, 'ff!')).toMatchObject({ ok: true, unconsumedFrom: null })
    }
    expect(emitAssemblySource(resolveTable(planted), planted, STRICT).source).not.toContain('function _tc')
  })

  it('keeps no-choice and unrelated dispatch closures on the direct route body', () => {
    const noChoice = manualPlan().prog
    const noChoiceClosure = { ...noChoice, asm: [] }
    const directSource = String(assemble(resolveTable(noChoiceClosure), noChoiceClosure, STRICT).pieces.Entry!)
    expect(directSource).not.toContain('sharedDecision')
    expect(directSource).not.toContain('classify')

    const relatedSelector = token(regex(/([a-z])\1+/))
    const unrelatedSelector = token(regex(/[A-Z]+/))
    const relatedDispatch = dispatch(relatedSelector, when('ff', literal('!')))
    const grammar = {
      Related: choice(
        transform(relatedDispatch, value => value),
        token(regex(/([a-z])\1+/)),
      ),
      RelatedDispatch: relatedDispatch,
      Unrelated: dispatch(unrelatedSelector, when('ABC', literal('!')), otherwise(literal('?'))),
    }
    const prog = encodeTable(grammar)
    expect(prog.tokenPlan?.choiceSites).toHaveLength(3)
    const closureProg = { ...prog, asm: [] }
    const asm = assemble(resolveTable(closureProg), closureProg, STRICT)
    const unrelatedSource = String(asm.pieces.Unrelated!)
    const relatedSource = String(asm.pieces.RelatedDispatch!)
    // RED provenance: restoring the 5064 shared-decision branch to every hot
    // dispatch puts `sharedDecision`/`classify` in `unrelatedSource`; removing
    // the related body makes the positive assertion fail.
    expect(unrelatedSource).not.toContain('sharedDecision')
    expect(unrelatedSource).not.toContain('classify')
    expect(relatedSource).toContain('classify')
    const map = tableRules(closureProg)
    expect(run(map.Unrelated!, 'ABC!')).toMatchObject({ ok: true, unconsumedFrom: null })
    expect(run(map.Related!, 'bb')).toMatchObject({ ok: true, unconsumedFrom: null })
  })

  it('restores routed state on a throwing hot route in closure, emitted, precompiled, and module engines', async () => {
    const parser = dispatch(
      token(regex(/[a-z]+/)),
      when('foo', sequence(
        routed(),
        transform(literal('!'), () => { throw new Error('boom') }),
      )),
    )
    const prog = encodeTable({ Entry: parser })
    expect(prog.tokenPlan?.sites.length).toBeGreaterThan(0)
    const loaded = await moduleRules(prog)
    const entries: Array<readonly [string, (input: string, pos: number, ctx: ParseContext) => unknown]> = [
      ['source', (input, pos, ctx) => parser.parse(input, pos, ctx)],
      ['closure', tableRules({ ...prog, asm: [] }).Entry!],
      ['emitted', tableRules(prog).Entry!],
      ['precompiled', tableRules(precompiled(prog)).Entry!],
      ['module', loaded.Entry!],
    ]
    for (const [name, entry] of entries) {
      const ctx = createParseContext()
      const sentinel = { value: 'outer', span: { start: 7, end: 12 } }
      ctx._routed = sentinel
      expect(() => entry('foo!', 0, ctx), name).toThrow('boom')
      expect(ctx._routed, name).toBe(sentinel)
    }
  })
})
