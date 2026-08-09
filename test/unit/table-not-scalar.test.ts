import { describe, expect, it } from 'vitest'
import { cstBuildHost, gate, label, literal, not, regex, run, sequence } from '../../src/index.ts'
import { buildGrammarPlan } from '../../src/compiler/grammar-coverage-ids.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { AssemblyCache, tableRules, type RunCfg } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_NOT } from '../../src/table/ops.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { scalarTerminalNotChild } from '../../src/table/scalar-terminal.ts'
import type { Combinator, ParseContext, ParseFail } from '../../src/types.ts'

type Entry = Parameters<typeof run>[0]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }
const CLOSURE_CFG: RunCfg = { ...STRICT, hostReadsChildren: true }

function program(entry: Combinator<unknown>, settings: Parameters<typeof encodeTable>[1] = {}): TableProgram {
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

function outcome(entry: Entry, input: string, opts: Parameters<typeof run>[2] = {}): string {
  const r = run(entry, input, opts)
  return digestValue({ ok: r.ok, value: r.value, span: r.span, expected: r.ok ? undefined : r.expected, errors: r.errors })
}

function expectAgreement(prog: TableProgram, interpreter: Combinator<unknown>, inputs: readonly string[], opts: Parameters<typeof run>[2] = {}): void {
  const es = entries(prog, interpreter)
  for (const input of inputs) {
    const expected = outcome(es.interpreter!, input, opts)
    for (const [name, entry] of Object.entries(es)) expect(outcome(entry, input, opts), `${name} ${JSON.stringify(input)}`).toBe(expected)
  }
}

function precompiled(prog: TableProgram, mutate: (source: string) => string = source => source): TableProgram {
  const em = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const compiled = new Function(...EMITTED_PARAMS, mutate(em.source)) as PrecompiledAssembly['factory']
  return { ...prog, asm: [{ key: 0, factory: compiled, plan: em.plan, reached: [...em.reached] }] }
}

describe('direct-terminal not() scalar consumer', () => {
  it('selects only direct untracked literal/regex children and reuses one pooled recognizer', () => {
    for (const child of [literal('x'), regex(/[x\u{10000}]/u)]) {
      const prog = program(not(child))
      const ip = notIp(prog)
      expect(scalarTerminalNotChild(prog.code, ip)).toBe(prog.code[ip + 1])
      const source = emitAssemblySource(resolveTable(prog), prog, STRICT).source
      expect(source).toContain('RECOG[')
      expect(source).not.toContain('rollbackTriviaAt(ctx,')
    }

    const shared = program(sequence(not(regex(/[a-z]/)), regex(/[a-z]/)))
    const source = emitAssemblySource(resolveTable(shared), shared, STRICT).source
    expect(source.match(/RECOG\[/g)).toHaveLength(1)
    // The raw terminal keeps its normal materializing body; adding a NOT consumer
    // must not silently route every same-spec terminal through another call.
    expect(source.match(/_rec\d+\(input,pos\)/g)).toHaveLength(1)

    const tracked = program(not(literal('\n')), { trackLines: true })
    expect(scalarTerminalNotChild(tracked.code, notIp(tracked))).toBe(-1)
    const wrapped = program(not(sequence(literal('x'))))
    expect(scalarTerminalNotChild(wrapped.code, notIp(wrapped))).toBe(-1)

    const direct = program(not(literal('x')))
    const child = direct.code[notIp(direct) + 1]!
    for (const cfg of [
      CLOSURE_CFG,
      { ...CLOSURE_CFG, tolerant: true },
      { ...CLOSURE_CFG, hostCst: true },
      { ...CLOSURE_CFG, probe: true },
    ]) {
      // These modes intentionally use the pure scalar consumer: the terminal
      // child body is not linked, so no CST/recovery/probe sink can be touched.
      expect(new AssemblyCache(direct).for(cfg).reached.has(child), JSON.stringify(cfg)).toBe(false)
    }
  })

  it('preserves literal, regex, EOF, non-ASCII and own failure diagnostics in every engine', () => {
    for (const grammar of [not(literal('x')), not(regex(/[x\u{10000}]/u))]) {
      const prog = program(grammar)
      expectAgreement(prog, grammar, ['', 'x', 'y', '\u{10000}'])
    }
    const g = sequence(not(literal('x')), regex(/./su))
    expectAgreement(program(g), g, ['', 'x', 'y', '\u{10000}'])
    const failed = run(tableRules(program(not(literal('x')))).Entry! as Entry, 'x')
    expect(failed).toMatchObject({ ok: false, span: { start: 0, end: 0 }, expected: ['not(literal)'] })
  })

  it('is zero-width and leaves prior expected/commit/probe and nested sinks untouched on both outcomes', () => {
    const seedGlobals = gate(state => {
      const { ctx, probe } = state as { ctx: ParseContext; probe: ParseFail }
      ctx._fc = true
      ctx._fe = 7
      ctx._fx = ['prior']
      ctx._probe = { offset: 7, best: probe }
      ctx._cstLeaves = [{ seed: true }]
      ctx._cstRawChildren = [{ raw: true }]
      ctx._cstTriviaLog = [1, 2, 0]
      ctx._triviaLog = [1, 2]
      ctx._fields = [{ name: 'seed', value: 1, span: { start: 0, end: 0 } }]
      ctx._errors = []
      return true
    })
    const grammar = sequence(seedGlobals, not(literal('x')))
    const prog = program(grammar)
    for (const [name, entry] of Object.entries(entries(prog, grammar))) {
      for (const input of ['x', 'y']) {
        const seed = { ok: false, expected: ['seed'], span: { start: 7, end: 7 } } as ParseFail
        const ctx = createParseContext()
        ctx.state = { ctx, probe: seed }
        const result = typeof entry === 'function'
          ? entry(input, 0, ctx)
          : (entry as Combinator<unknown>).parse(input, 0, ctx)
        expect(result, `${name} ${input}`).toMatchObject(input === 'x' ? { ok: false, span: { start: 0, end: 0 } } : { ok: true, span: { start: 0, end: 0 } })
        // The seeding gate runs INSIDE the entry, after the table boundary reset.
        // This catches a child diagnostic/commit leak that a pre-call seed cannot.
        expect(ctx._fc, name).toBe(true)
        expect(ctx._probe!.best, name).toBe(seed)
        expect(ctx._cstLeaves, name).toEqual([{ seed: true }])
        expect(ctx._cstRawChildren, name).toEqual([{ raw: true }])
        expect(ctx._cstTriviaLog, name).toEqual([1, 2, 0])
        expect(ctx._triviaLog, name).toEqual([1, 2])
        expect(ctx._fields, name).toHaveLength(1)
        expect(ctx._errors, name).toEqual([])
        if (input === 'y') {
          expect(ctx._fe, name).toBe(7)
          expect(ctx._fx, name).toEqual(['prior'])
        } else if (name !== 'interpreter') {
          expect(ctx._fe, name).toBe(0)
          expect(ctx._fx, name).toEqual(['not(literal)'])
        } else {
          expect(ctx._fe, name).toBe(7)
          expect(ctx._fx, name).toEqual(['prior'])
        }
      }
    }
  })

  it('keeps tolerant, CST and tracked variants on their exact semantic paths', () => {
    const g = sequence(not(literal('x')), literal('y'))
    const prog = program(g)
    expectAgreement(prog, g, ['y', 'x', ''])
    expectAgreement(prog, g, ['y', 'x', ''], { tolerant: true })

    const cstProg = program(g, { hostMode: 'cst' })
    expectAgreement(cstProg, g, ['y', 'x', ''], { build: cstBuildHost({ tags: true }) })

    const tracked = program(g, { trackLines: true })
    expect(scalarTerminalNotChild(tracked.code, notIp(tracked))).toBe(-1)
    const trackedEntries = entries(tracked, g)
    const expected = outcome(trackedEntries.reference!, 'y')
    expect(outcome(trackedEntries.closure!, 'y')).toBe(expected)
    expect(outcome(trackedEntries.emitted!, 'y')).toBe(expected)
  })

  it('declines a coverage-bearing child and preserves its exact hit behavior', () => {
    const grammar = not(label('inner', literal('x')))
    const plan = buildGrammarPlan(grammar)
    const prog = program(grammar, { coverage: plan })
    const ip = notIp(prog)
    expect(plan.definitions).toEqual([{ id: 'label:entry/not:0', kind: 'label' }])
    expect(scalarTerminalNotChild(prog.code, ip)).toBe(-1)

    for (const [input, expectedHits] of [['x', ['label:entry/not:0']], ['y', []]] as const) {
      const hits: string[] = []
      const ctx = createParseContext()
      ctx._grammarCoverage = id => hits.push(id)
      const entry = tableRules({ ...prog, asm: [] }).Entry! as Entry
      const result = typeof entry === 'function'
        ? entry(input, 0, ctx)
        : entry.parse(input, 0, ctx)
      expect(result).toMatchObject(input === 'x' ? { ok: false } : { ok: true })
      expect(hits).toEqual(expectedHits)
    }
  })

  it('round-trips the existing precompiled recognizer ABI', () => {
    const g = not(regex(/[a-z]+/))
    const prog = program(g)
    const es = entries(prog, g)
    es.precompiled = tableRules(precompiled(prog)).Entry! as Entry
    for (const input of ['', 'abc', '?']) {
      const expected = outcome(es.interpreter!, input)
      for (const [name, entry] of Object.entries(es)) expect(outcome(entry, input), name).toBe(expected)
    }
  })

  it('has semantic RED plants for both assertion directions', () => {
    const g = not(literal('x'))
    const prog = program(g)
    const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT).source

    const wrongSuccess = emitted.replace('{EC.e=pos;return null}', '{EC.e=pos;return FAIL}')
    expect(wrongSuccess).not.toBe(emitted)
    const successEntry = tableRules(precompiled(prog, () => wrongSuccess)).Entry! as Entry
    expect(outcome(successEntry, 'y')).not.toBe(outcome(g as Entry, 'y'))

    const wrongFailure = emitted.replace('ctx._fx=', 'ctx._fx=EMPTY_FX;//')
    expect(wrongFailure).not.toBe(emitted)
    const failureEntry = tableRules(precompiled(prog, () => wrongFailure)).Entry! as Entry
    expect(outcome(failureEntry, 'x')).not.toBe(outcome(g as Entry, 'x'))
  })
})
