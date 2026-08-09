import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { choice, dispatch, literal, matches, optional, otherwise, regex, routed, sequence, token, transform, when } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import {
  ownTableProgram, resolveTable, type PrecompiledAssembly, type TableProgram,
} from '../../src/table/program.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE, OP_DISPATCH, OP_XFORM } from '../../src/table/ops.ts'
import { run } from '../../src/functional/run.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { FAIL } from '../../src/table/cell.ts'
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
  const later = token(native ? regex(/([a-z])\1+/) : regex(/[a-z]+/))
  const prog = encodeTable({
    Entry: choice(transform(parser, value => value), later),
    Dispatch: parser,
  })
  expect(prog.tokenPlan?.choiceSites).toHaveLength(3)
  return { parser, prog }
}

function unsupportedPlan(): {
  readonly parser: ReturnType<typeof dispatch>
  readonly planned: TableProgram
  readonly injected: TableProgram
} {
  const active = manualPlan()
  const base = active.prog.tokenPlan!
  const outcomeData = [...base.outcomeData]
  const exactAt = base.outcomeOffsets.find(at => base.outcomeData[at + 2] === 0)!
  const unsupportedK = active.prog.k.length
  outcomeData[exactAt + 2] = 3
  outcomeData[exactAt + 3] = unsupportedK
  const { tokenPlan: _plan, ...legacy } = active.prog
  return {
    parser: active.parser,
    planned: ownTableProgram(legacy),
    injected: ownTableProgram({
      ...active.prog,
      k: [...active.prog.k, /^a.+z$/],
      tokenPlan: { ...base, outcomeData },
    }),
  }
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
  const tokenPlan = raw.tokenPlan!
  expect(tokenPlan.choiceSites).toEqual([choiceIp, 0, 0])
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

function fixedChoicePlan(base: RegExp = /(?:[a-z]|\\.)+/i): {
  readonly parser: ReturnType<typeof choice>
  readonly prog: TableProgram
  readonly calls: () => number
  readonly stacks: () => readonly string[]
} {
  const opener = (): ReturnType<typeof token> => token(sequence(
    regex(base),
    optional(literal('(')),
  ))
  const selector = opener()
  const classified = dispatch(
    selector,
    when('each(', sequence(routed(), literal('!')), { caseInsensitive: true }),
    when(matches(/^(?!(?:url|calc)\($).+\($/i), sequence(routed(), literal('?'))),
  )
  const parser = choice(transform(classified, value => value), opener(), literal('!'))
  const raw = encodeTable({ Entry: parser, Dispatch: classified })
  expect(raw.tokenPlan?.choiceSites).toHaveLength(3)
  let calls = 0
  const stacks: string[] = []
  const constants = raw.k.map(value => {
    if (!(value instanceof RegExp) || value.source !== base.source) return value
    const copy = new RegExp(value.source, `${value.flags.replace(/[gy]/g, '')}y`)
    const exec = copy.exec
    copy.exec = function (input: string) {
      calls++
      stacks.push(new Error().stack ?? '')
      return exec.call(this, input)
    }
    return copy
  })
  return { parser, prog: ownTableProgram({ ...raw, k: constants }), calls: () => calls, stacks: () => stacks }
}

function fixedFailurePlan(): {
  readonly parser: ReturnType<typeof choice>
  readonly prog: TableProgram
} {
  const opener = (): ReturnType<typeof token> => token(sequence(
    regex(/(?:[a-z]|\\.)+/i),
    optional(literal('(')),
  ))
  const classified = dispatch(
    opener(),
    when('each(', sequence(routed(), literal('!')), { caseInsensitive: true }),
    when(matches(/^(?!(?:url|calc)\($).+\($/i), sequence(routed(), literal('?'))),
  )
  const parser = choice(
    transform(classified, value => value),
    sequence(opener(), literal('#')),
  )
  return { parser, prog: encodeTable({ Entry: parser }) }
}

function staleFixedPlan(): {
  readonly parser: ReturnType<typeof choice>
  readonly prog: TableProgram
  readonly calls: () => number
} {
  const base = /(?:[a-z]|\\.)+/i
  const opener = (): ReturnType<typeof token> => token(sequence(regex(base), optional(literal('('))))
  const classifier = (exact: string, exactTerm: string, genericTerm: string): ReturnType<typeof dispatch> => dispatch(
    opener(),
    when(exact, sequence(routed(), literal(exactTerm)), { caseInsensitive: true }),
    when(matches(/^(?!(?:url|calc)\($).+\($/i), sequence(routed(), literal(genericTerm))),
  )
  const first = classifier('each(', '?', '!')
  const second = classifier('foo(', '!', '#')
  const parser = choice(sequence(first, literal('$')), second)
  const raw = encodeTable({
    Entry: parser,
    AnchorFirst: choice(transform(first, value => value), opener()),
    AnchorSecond: choice(transform(second, value => value), opener()),
  })
  expect(raw.tokenPlan?.choiceSites).toHaveLength(6)
  let calls = 0
  const constants = raw.k.map(value => {
    if (!(value instanceof RegExp) || value.source !== base.source) return value
    const copy = new RegExp(value.source, `${value.flags.replace(/[gy]/g, '')}y`)
    const exec = copy.exec
    copy.exec = function (input: string) { calls++; return exec.call(this, input) }
    return copy
  })
  return { parser, prog: ownTableProgram({ ...raw, k: constants }), calls: () => calls }
}

function emittedFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return ''
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source.charCodeAt(i)
    if (c === 123) depth++
    else if (c === 125 && --depth === 0) return source.slice(start, i + 1)
  }
  return ''
}

describe('table token stream runtime', () => {
  it('fuses the fixed opener and two outcomes into one cached site decision', async () => {
    for (const mode of ['closure', 'emitted', 'precompiled'] as const) {
      for (const input of ['EaCh(!', 'ordinary(?', 'url(', 'calc(', 'bare', 'escaped\\(']) {
        const counted = fixedChoicePlan()
        const prog = mode === 'closure' ? { ...counted.prog, asm: [] }
          : mode === 'precompiled' ? precompiled(counted.prog) : counted.prog
        const actual = run(tableRules(prog).Entry!, input)
        const expected = run(counted.parser, input)
        expect(actual, `${mode} ${input}`).toMatchObject({
          ok: expected.ok, value: expected.value, expected: expected.expected, unconsumedFrom: expected.unconsumedFrom,
        })
        expect(counted.calls(), `${mode} ${input} base scans`).toBe(input === '!' ? 0 : 1)
        if (counted.stacks().length > 0) {
          const genericFrame = mode === 'closure' ? 'recognizeToken' : '_tokRecognize'
          expect(counted.stacks().join('\n'), `fixed ${mode} bypasses the generic recognizer call`)
            .not.toContain(genericFrame)
        }
      }
    }

    const structural = fixedChoicePlan().prog
    const emitted = emitAssemblySource(resolveTable(structural), structural, STRICT).source
    const fixed = emittedFunction(emitted, '_tc0')
    expect(fixed).toContain('let end=_rec')
    expect(fixed).toContain('_pfTokOutcome=')
    expect(fixed).not.toContain('_tokRecognize')
    expect(fixed).not.toContain('_td')

    const generic = countedChoicePlan().prog
    const genericSource = emittedFunction(emitAssemblySource(resolveTable(generic), generic, STRICT).source, '_tc0')
    expect(genericSource).toContain('_tokRecognize')
    expect(genericSource).toContain('_td')

    const loaded = await moduleRules(structural)
    const loadedEntry = loaded.Entry! as Parameters<typeof run>[0]
    const originalExec = RegExp.prototype.exec
    RegExp.prototype.exec = function (input: string): RegExpExecArray | null {
      if ((new Error().stack ?? '').includes('_tokRecognize')) {
        throw new Error('module entered generic token recognition')
      }
      return originalExec.call(this, input)
    }
    try {
      for (const input of ['EaCh(!', 'ordinary(?', 'url(', 'bare', 'escaped\\(']) {
        expect(run(loadedEntry, input)).toMatchObject(run(fixedChoicePlan().parser, input))
      }
    } finally {
      RegExp.prototype.exec = originalExec
    }
  })

  it('keeps bounded-dot line terminator semantics and fixed cursor reentry exact', async () => {
    const lineBase = /(?:[a-z\r\n\u2028\u2029]|\\.)+/i
    const inputs = ['a\n(', 'a\r(', 'a\u2028(', 'a\u2029(']
    const structural = fixedChoicePlan(lineBase)
    const loaded = await moduleRules(structural.prog)
    const loadedEntry = loaded.Entry! as Parameters<typeof run>[0]
    for (const mode of ['closure', 'emitted', 'precompiled'] as const) {
      for (const input of inputs) {
        const counted = fixedChoicePlan(lineBase)
        const prog = mode === 'closure' ? { ...counted.prog, asm: [] }
          : mode === 'precompiled' ? precompiled(counted.prog) : counted.prog
        expect(run(tableRules(prog).Entry!, input), `${mode} ${JSON.stringify(input)}`)
          .toMatchObject(run(counted.parser, input))
        expect(counted.calls()).toBe(1)
      }
    }
    for (const input of inputs) expect(run(loadedEntry, input)).toMatchObject(run(structural.parser, input))

    const counted = fixedChoicePlan()
    const prog = { ...counted.prog, asm: [] }
    const asm = assemble(resolveTable(prog), prog, STRICT)
    const outer = createParseContext(), inner = createParseContext()
    asm.begin(outer)
    expect(asm.pieces.Entry!('bare', 0, outer)).not.toBe(false)
    expect(counted.calls()).toBe(1)
    asm.begin(inner)
    expect(asm.pieces.Entry!('ordinary(?', 0, inner)).not.toBe(false)
    expect(counted.calls()).toBe(2)
    asm.finish()
    expect(asm.pieces.Dispatch!('bare', 0, outer)).toBe(FAIL)
    expect(counted.calls(), 'restored outer no-route decision was reused').toBe(2)
    asm.finish()
    asm.begin(outer)
    expect(asm.pieces.Entry!('bare', 0, outer)).not.toBe(false)
    expect(counted.calls(), 'outer finish released the fixed cursor').toBe(3)
    asm.finish()
  })

  it('preserves deferred no-route expectations and selected-route commitment', async () => {
    const fixture = fixedFailurePlan()
    expect(fixture.prog.tokenPlan?.choiceSites).toHaveLength(3)
    const loaded = await moduleRules(fixture.prog)
    const engines = [
      tableRules({ ...fixture.prog, asm: [] }).Entry!,
      tableRules(fixture.prog).Entry!,
      tableRules(precompiled(fixture.prog)).Entry!,
      loaded.Entry!,
    ]
    for (const input of ['bare', 'url(', 'calc(', 'ordinary(!', 'each(?']) {
      const source = fixture.parser.parse(input, 0, createParseContext())
      if (source.ok) throw new Error(`source unexpectedly accepted ${input}`)
      for (const entry of engines) {
        const ctx = createParseContext()
        const actual = entry(input, 0, ctx) as typeof source
        expect(actual, input).toEqual(source)
        expect({ expected: ctx._fx, start: ctx._fe, committed: ctx._fc }, input).toEqual({
          expected: source.expected,
          start: source.span.start,
          committed: source.committed ?? false,
        })
      }
    }
  })

  it('reclassifies a shared family range for a different site without rescanning', async () => {
    for (const mode of ['closure', 'emitted', 'precompiled'] as const) {
      const fixture = staleFixedPlan()
      const prog = mode === 'closure' ? { ...fixture.prog, asm: [] }
        : mode === 'precompiled' ? precompiled(fixture.prog) : fixture.prog
      const actual = run(tableRules(prog).Entry!, 'foo(!')
      expect(actual, mode).toMatchObject(run(fixture.parser, 'foo(!'))
      expect(actual.ok, mode).toBe(true)
      expect(fixture.calls(), `${mode} shared base scans`).toBe(1)
    }
    const fixture = staleFixedPlan()
    const loaded = await moduleRules(fixture.prog)
    expect(run(loaded.Entry! as Parameters<typeof run>[0], 'foo(!'))
      .toMatchObject(run(fixture.parser, 'foo(!'))
  })

  it('routes one atomic range and preserves canonical miss diagnostics', () => {
    const { parser, prog } = manualPlan()
    const closure = tableRules({ ...prog, asm: [] }).Dispatch!
    const emitted = tableRules(prog).Dispatch!
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
      const { prog: raw } = manualPlan(true)
      const plan = raw.tokenPlan!
      const recognizer = plan.sites[1]! - 3
      const recognizerAt = plan.recognizerOffsets[recognizer]!
      const recognizerK = plan.recognizerData[recognizerAt + 2]!
      const originalRe = raw.k[recognizerK] as RegExp
      let calls = 0
      const constants = raw.k.map(value => {
        if (!(value instanceof RegExp) || value.source !== originalRe.source) return value
        const re = new RegExp(value.source, `${value.flags.replace(/[gy]/g, '')}y`)
        const original = re.exec
        re.exec = function (input: string) { calls++; return original.call(this, input) }
        return re
      })
      const prog = ownTableProgram({ ...raw, k: constants })
      const entry = tableRules(mode === 'closure' ? { ...prog, asm: [] } : prog).Dispatch!

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
    for (const entry of [tableRules({ ...planted, asm: [] }).Dispatch!, tableRules(planted).Dispatch!]) {
      expect(run(entry, 'foo!').ok).toBe(false)
    }
  })

  it('restores a pending range across reentry and releases it after outer finish', () => {
    const selector = token(regex(/([a-z])\1+/))
    const classified = dispatch(selector, when('ff', literal('!')), otherwise(literal('?')))
    const grammar = {
      Entry: choice(transform(classified, value => value), selector),
      Selector: selector,
      Dispatch: classified,
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
    const prog = encodeTable({
      Entry: parser,
      Anchor: choice(transform(parser, value => value), selector),
    })
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
    expect(planned.tokenPlan).toBeUndefined()
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

  it('rejects a sparse wire whose active family points at a recognizer hole', () => {
    const { prog } = manualPlan()
    const plan = prog.tokenPlan!
    const recognizerOffsets = [...plan.recognizerOffsets]
    recognizerOffsets[plan.sites[1]! - 3] = -1
    const malformed = ownTableProgram({
      ...prog,
      tokenPlan: { ...plan, recognizerOffsets },
    })
    expect(() => run(tableRules({ ...malformed, asm: [] }).Entry!, 'foo!')).toThrow('invalid token or family')
    expect(() => run(tableRules(malformed).Entry!, 'foo!')).toThrow()

    const activeRecognizer = plan.sites[1]! - 3
    const at = plan.recognizerOffsets[activeRecognizer]!
    const holeOffsets = [...plan.recognizerOffsets]
    holeOffsets[activeRecognizer] = -1
    const outOfRangeOffsets = [...plan.recognizerOffsets]
    outOfRangeOffsets[activeRecognizer] = plan.recognizerData.length + 1
    const malformedWires = [
      { ...plan, recognizerOffsets: holeOffsets },
      { ...plan, recognizerOffsets: outOfRangeOffsets },
      { ...plan, recognizerData: [...plan.recognizerData, 0] },
    ]
    expect(at).toBeGreaterThanOrEqual(0)
    for (const tokenPlan of malformedWires) {
      const direct = ownTableProgram({ ...prog, tokenPlan })
      expect(() => emitAssemblySource(resolveTable(direct), direct, STRICT))
        .toThrow('malformed token-plan recognizer')
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

  it('defensively leaves an unanchored serialized dispatch on exact legacy shape', () => {
    const active = manualPlan().prog
    const plan = active.tokenPlan!
    const { choiceSites: _choices, ...unanchoredPlan } = plan
    const unanchored = ownTableProgram({ ...active, tokenPlan: unanchoredPlan })
    const { tokenPlan: _plan, ...legacyData } = active
    const legacy = ownTableProgram(legacyData)

    expect(assemblyShape(unanchored)).toEqual(assemblyShape(legacy))
    const source = emitAssemblySource(resolveTable(unanchored), unanchored, STRICT).source
    expect(source).not.toContain('_pfTokInput')
    expect(source).not.toContain('_tokRecognize')
    for (const input of ['foo!', 'bar?', '1']) {
      expect(run(tableRules(unanchored).Dispatch!, input)).toEqual(run(tableRules(legacy).Dispatch!, input))
    }
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
      const classified = dispatch(first, when('ff', literal('!')))
      const raw = encodeTable({ Entry: choice(transform(classified, value => value), later) })
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
    const classified = dispatch(selector, when('ff', literal('!')))
    const parser = choice(
      transform(classified, value => value),
      literal('!'),
    )
    const active = choice(transform(classified, value => value), selector)
    const raw = encodeTable({ Entry: parser, Active: active })
    expect(raw.tokenPlan?.choiceSites).toHaveLength(3)
    const resolved = resolveTable(raw)
    const choiceIp = [...reachableIps(raw)].find(ip => raw.code[ip] === OP_CHOICE
      && resolved.disp[raw.code[ip + 1]!]!.exclusive)!
    const validChoice = raw.tokenPlan!.choiceSites![0]!
    const validArm = raw.tokenPlan!.choiceSites![1]!
    const wrongSites = [...raw.tokenPlan!.sites]
    wrongSites[0] = wrongSites[0]! + 1
    const malformedPlans = [
      { ...raw.tokenPlan!, choiceSites: [choiceIp, 0, 0] },
      { ...raw.tokenPlan!, choiceSites: [validChoice, validArm + 1, 0] },
      { ...raw.tokenPlan!, sites: wrongSites },
    ]
    const { tokenPlan: _plan, ...legacyData } = raw
    const legacy = ownTableProgram(legacyData)
    for (const tokenPlan of malformedPlans) {
      const planted = ownTableProgram({ ...raw, tokenPlan })
      expect(assemblyShape(planted)).toEqual(assemblyShape(legacy))
      for (const entry of [tableRules({ ...planted, asm: [] }).Entry!, tableRules(planted).Entry!]) {
        expect(run(entry, 'ff!')).toMatchObject({ ok: true, unconsumedFrom: null })
      }
      const source = emitAssemblySource(resolveTable(planted), planted, STRICT).source
      expect(source).not.toContain('function _tc')
      expect(source).not.toContain('_pfTokInput')
      expect(source).not.toContain('_tokRecognize')
    }
  })

  it('defensively declines two token relations owned by one choice', () => {
    const first = token(regex(/[a-z]+/))
    const second = token(regex(/[a-z]+/))
    const firstDispatch = dispatch(first, when('aa', literal('!')))
    const secondDispatch = dispatch(second, when('bb', literal('?')))
    const ambiguous = choice(
      transform(firstDispatch, value => value),
      transform(secondDispatch, value => value),
      first,
    )
    const raw = encodeTable({
      Entry: ambiguous,
      FirstAnchor: choice(transform(firstDispatch, value => value), first),
      SecondAnchor: choice(transform(secondDispatch, value => value), second),
    })
    const plan = raw.tokenPlan!
    expect(plan.sites).toHaveLength(8)
    const ambiguousIp = [...reachableIps(raw)].find(ip => {
      if (raw.code[ip] !== OP_CHOICE || raw.code[ip + 2]! < 2) return false
      for (const arm of [0, 1]) {
        const xf = raw.code[ip + 4 + arm]!
        if (raw.code[xf] !== OP_XFORM || raw.code[raw.code[xf + 2]!] !== OP_DISPATCH) return false
      }
      return true
    })!
    const planted = ownTableProgram({
      ...raw,
      tokenPlan: { ...plan, choiceSites: [ambiguousIp, 0, 0, ambiguousIp, 1, 1] },
    })
    const { tokenPlan: _plan, ...legacyData } = raw
    const legacy = ownTableProgram(legacyData)

    expect(assemblyShape(planted)).toEqual(assemblyShape(legacy))
    const source = emitAssemblySource(resolveTable(planted), planted, STRICT).source
    expect(source).not.toContain('_pfTokInput')
    expect(source).not.toContain('_tokRecognize')
  })

  it('keeps no-choice and unrelated dispatch closures on the direct route body', () => {
    const noChoiceSelector = token(regex(/[a-z]+/))
    const noChoice = encodeTable({
      Entry: dispatch(noChoiceSelector, when('foo', literal('!')), otherwise(literal('?'))),
    })
    expect(noChoice.tokenPlan).toBeUndefined()
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
    const selector = token(regex(/[a-z]+/))
    const parser = dispatch(
      selector,
      when('foo', sequence(
        routed(),
        transform(literal('!'), () => { throw new Error('boom') }),
      )),
    )
    const prog = encodeTable({
      Entry: parser,
      Anchor: choice(transform(parser, value => value), selector),
    })
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
