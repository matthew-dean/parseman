import { describe, expect, it } from 'vitest'
import {
  cstBuildHost, literal, node, regex, rules, run, sequence,
} from '../../src/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_NODE, OP_NODE_TRACK, OP_RX, OP_RX_TRACK } from '../../src/table/ops.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { scalarTerminalNodeChild } from '../../src/table/scalar-terminal.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'

type Entry = Parameters<typeof run>[0]
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function word(value = regex(/[a-z]+/)): Combinator<unknown> {
  return node('Word', value, (children, _fields, span, rawChildren) => ({
    kind: 'word', children, rawChildren, span, distinct: children !== rawChildren,
  }))
}

function program(entry: Combinator<unknown> = word(), settings: Parameters<typeof encodeTable>[1] = {}): TableProgram {
  return encodeTable({ Entry: entry }, settings)
}

function nodeIp(prog: TableProgram): number {
  const nodes = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_NODE || prog.code[ip] === OP_NODE_TRACK)
  expect(nodes).toHaveLength(1)
  return nodes[0]!
}

function drivers(prog: TableProgram, interpreter?: Combinator<unknown>): Record<string, Entry> {
  const out: Record<string, Entry> = {
    emitted: tableRules(prog).Entry! as Entry,
    closure: tableRules({ ...prog, asm: [] }).Entry! as Entry,
    reference: execRules(prog).Entry! as Entry,
  }
  if (interpreter !== undefined) out.interpreter = interpreter as Entry
  return out
}

function outcome(entry: Entry, input: string, opts: Parameters<typeof run>[2] = {}): string {
  const r = run(entry, input, opts)
  return digestValue({
    ok: r.ok, value: r.value, span: r.span,
    expected: r.ok ? undefined : r.expected,
    errors: r.errors, unconsumedFrom: r.unconsumedFrom,
  })
}

function expectDriversAgree(es: Record<string, Entry>, inputs: readonly string[], opts: Parameters<typeof run>[2] = {}): void {
  for (const input of inputs) {
    const expected = outcome(es.emitted!, input, opts)
    for (const [name, entry] of Object.entries(es)) {
      if (name !== 'emitted') expect(outcome(entry, input, opts), `${name} ${JSON.stringify(input)}`).toBe(expected)
    }
  }
}

function expectAgreement(
  prog: TableProgram, inputs: readonly string[], opts: Parameters<typeof run>[2] = {},
  interpreter?: Combinator<unknown>,
): void {
  expectDriversAgree(drivers(prog, interpreter), inputs, opts)
}

function precompiled(
  prog: TableProgram, mutate: (source: string) => string = source => source,
): { prog: TableProgram; calls: () => number } {
  const em = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const source = mutate(em.source)
  const compiled = new Function(...EMITTED_PARAMS, source) as PrecompiledAssembly['factory']
  let calls = 0
  const factory = ((...args: Parameters<PrecompiledAssembly['factory']>) => {
    calls++
    return compiled(...args)
  }) as PrecompiledAssembly['factory']
  return {
    prog: { ...prog, asm: [{ key: 0, factory, plan: em.plan, reached: [...em.reached] }] },
    calls: () => calls,
  }
}

function expectSpecial(prog: TableProgram): void {
  const ip = nodeIp(prog)
  expect(scalarTerminalNodeChild(prog.code, ip)).toBe(prog.code[ip + 2])
  const source = emitAssemblySource(resolveTable(prog), prog, STRICT).source
  expect(source).toContain('const kids=[leaf],rawKids=[leaf],span={start:pos,end}')
  expect(source).not.toContain('const sCh=ctx._cstChildren')
}

describe('direct terminal-node scalar materialization', () => {
  it('binds direct strict-AST RX/LIT nodes and emits one shared raw/node recognizer', () => {
    expectSpecial(program())
    expectSpecial(program(word(literal('ok'))))

    const pattern = /[a-z]/
    const shared = program(sequence(word(regex(pattern)), regex(pattern)))
    const rxIps = [...reachableIps(shared)].filter(ip => shared.code[ip] === OP_RX)
    expect(rxIps).toHaveLength(2)
    expect(shared.code[rxIps[0]! + 1]).toBe(shared.code[rxIps[1]! + 1])
    const source = emitAssemblySource(resolveTable(shared), shared, STRICT).source
    // One hoisted RECOG pool read feeds the direct node and a distinct ordinary
    // terminal row with the same pooled RegExp; neither body owns another scan.
    expect(source.match(/RECOG\[/g)).toHaveLength(1)
    const binding = /const (_rec\d+)=RECOG\[/.exec(source)?.[1]
    expect(binding).toBeDefined()
    expect(source.split(`${binding!}(input,pos)`).length - 1).toBe(2)
    expectAgreement(shared, ['ab', 'a?', ''])

    // A hand-built tracked row may share that same pooled spec, but its opcode
    // contract still owns line tracking and must not take the scalar raw path.
    const baseTable = resolveTable(shared)
    const mixedCode = Int32Array.from(baseTable.code)
    const nodeChild = mixedCode[nodeIp(shared) + 2]!
    const tracked = rxIps.find(ip => ip !== nodeChild)!
    mixedCode[tracked] = OP_RX_TRACK
    const mixedSource = emitAssemblySource({ ...baseTable, code: mixedCode }, shared, STRICT).source
    expect(mixedSource.match(/RECOG\[/g)).toHaveLength(1)
    expect(mixedSource).toContain('_trackLines(ctx,input,e)')
  })

  it('has a test-local RED plant for the exact eligibility proof', () => {
    const clean = program()
    const planted = { ...clean, code: [...clean.code] }
    const flags = nodeIp(planted) + 3
    planted.code[flags] = planted.code[flags]! | 4 // pretend the reducer reads trivia
    expect(() => expectSpecial(planted)).toThrow()
    expectSpecial(clean)
  })

  it('declines every semantic shape outside the bounded strict-AST contract', () => {
    const declined: TableProgram[] = [
      program(node('Projected', regex(/[a-z]+/), { project: 0 })),
      program(node('Trivia', regex(/[a-z]+/), (_c, _f, _s, _r, tl) => tl, { captureTrivia: true })),
      program(word(), { trackLines: true }),
    ]
    for (const prog of declined) expect(scalarTerminalNodeChild(prog.code, nodeIp(prog))).toBe(-1)

    const eligible = program()
    for (const cfg of [
      { ...STRICT, tolerant: true },
      { ...STRICT, probe: true },
      { ...STRICT, hostCst: true },
      { ...STRICT, trackLines: true },
    ]) {
      const source = emitAssemblySource(resolveTable(eligible), eligible, cfg).source
      expect(source).not.toContain('const kids=[leaf],rawKids=[leaf],span={start:pos,end}')
    }

    // Coverage emission is deliberately refused, so its cfg-dependent bypass
    // is proved on the closure assembly: the generic node links/reaches its
    // terminal child instead of subsuming it in the scalar node piece.
    const ip = nodeIp(eligible)
    const child = eligible.code[ip + 2]!
    const covered = assemble(resolveTable(eligible), eligible, { ...STRICT, coverage: true })
    expect(covered.emitRefusal).toContain('coverage assembly')
    expect(covered.reached.has(child)).toBe(true)
  })

  it('preserves AST/raw leaf identity, spans, ambient trivia, expected and EOF in all engines', () => {
    // An outer node makes the specialized Word publish into a live parent
    // capture buffer. Trivia is consumed before Word, never inside its body.
    const grammar = rules<Record<string, Combinator<unknown>>>({ trivia: regex(/\s+/) }, g => ({
      Word: word(),
      Entry: node('Doc', sequence(literal('['), g.Word, literal(']')),
        (children, _fields, span, rawChildren) => ({ kind: 'doc', children, rawChildren, span })),
    }))
    const prog = encodeTable(grammar)
    expectAgreement(prog, ['[abc]', '[ abc ]', '[?]', '[', ''], {}, grammar.Entry)
    for (const entry of Object.values(drivers(prog))) {
      const r = run(entry, '[ abc ]')
      expect(r.ok).toBe(true)
      const doc = r.value as { children: Array<{ kind?: string; distinct?: boolean; children?: unknown[]; rawChildren?: unknown[] }> }
      const built = doc.children.find(child => child.kind === 'word')!
      expect(built.distinct).toBe(true)
      expect(built.children).not.toBe(built.rawChildren)
      expect(built.children?.[0]).toBe(built.rawChildren?.[0])
    }
  })

  it('bypasses for CST hosts, tolerant recovery assemblies and completion probes', () => {
    const original = word()
    const prog = program(original)
    const cstOriginal = word()
    const cstProg = program(cstOriginal, { hostMode: 'cst' })
    expectAgreement(cstProg, ['abc', '?'], { build: cstBuildHost({ tags: true }) }, cstOriginal)
    expectAgreement(prog, ['abc', '?'], { tolerant: true }, original)

    for (const [name, entry] of Object.entries(drivers(prog))) {
      const ctx = createParseContext()
      ctx._probe = { offset: 0, best: null }
      const result = (entry as (input: string, pos: number, ctx: ParseContext) => unknown)('?', 0, ctx)
      expect(result, name).toMatchObject({ ok: false })
      expect(ctx._probe.best?.expected, name).toEqual(['/[a-z]+/'])
    }

    const assembled = assemble(resolveTable(prog), prog, STRICT)
    expect(assembled.emitRefusal).toBeUndefined()
  })

  it('round-trips an eligible precompiled factory with the appended recognizer ABI', () => {
    const original = word()
    const prog = program(original)
    const pre = precompiled(prog)
    const es = drivers(prog, original)
    es.precompiled = tableRules(pre.prog).Entry! as Entry
    expectDriversAgree(es, ['abc', '?', ''])
    expect(pre.calls()).toBe(1)
  })

  it('has a semantic RED plant for leaf/raw materialization parity', () => {
    const original = word()
    const prog = program(original)
    const planted = precompiled(prog, source => {
      const bad = source.replace(
        'const kids=[leaf],rawKids=[leaf],span={start:pos,end}',
        'const kids=[leaf],rawKids=[],span={start:pos,end}',
      )
      expect(bad).not.toBe(source)
      return bad
    })
    const es = drivers(prog, original)
    es.emitted = tableRules(planted.prog).Entry! as Entry
    expect(() => expectDriversAgree(es, ['abc'])).toThrow()
  })
})
