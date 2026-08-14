import { describe, expect, it } from 'vitest'
import {
  choice, cstBuildHost, dispatch, literal, many, node, optional, regex, run,
  sepBy, sequence, transform, when,
} from '../../src/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_REP, OP_REPV } from '../../src/table/ops.ts'
import { resolveTable, type TableProgram } from '../../src/table/program.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'

type Entry = Parameters<typeof run>[0]

function repeatIp(prog: TableProgram): number {
  const repeats = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_REP || prog.code[ip] === OP_REPV)
  expect(repeats).toHaveLength(1)
  return repeats[0]!
}

function rowWidth(prog: TableProgram, ip: number): number {
  const ips = [...reachableIps(prog)].sort((a, b) => a - b)
  const at = ips.indexOf(ip)
  expect(at).toBeGreaterThanOrEqual(0)
  return (ips[at + 1] ?? prog.code.length) - ip
}

/** Prime the class pool before encoding the repeat, without changing its item. */
function finiteProgram(first = 'a'): TableProgram {
  return encodeTable({
    Prime: choice(literal('a'), literal('b')),
    Entry: many(sequence(literal(first), literal('!'))),
  })
}

function drivers(prog: TableProgram): Record<'emitted' | 'closure' | 'reference', Entry> {
  return {
    emitted: tableRules(prog).Entry! as Entry,
    // An empty precompiled-assembly list is the standing measurement toggle for
    // the canonical closure assembly (see the closure-engine matrix tests).
    closure: tableRules({ ...prog, asm: [] }).Entry! as Entry,
    reference: execRules(prog).Entry! as Entry,
  }
}

function outcome(entry: Entry, input: string, opts: Parameters<typeof run>[2] = {}): string {
  const r = run(entry, input, opts)
  return digestValue({
    ok: r.ok,
    value: r.value,
    span: r.span,
    expected: r.ok ? undefined : [...r.expected].sort(),
    errors: r.errors,
    unconsumedFrom: r.unconsumedFrom,
  })
}

function expectAgreement(
  prog: TableProgram,
  inputs: readonly string[],
  opts: Parameters<typeof run>[2] = {},
): void {
  const es = drivers(prog)
  for (const input of inputs) {
    const expected = outcome(es.emitted, input, opts)
    expect(outcome(es.closure, input, opts), `closure ${JSON.stringify(input)}`).toBe(expected)
    expect(outcome(es.reference, input, opts), `reference ${JSON.stringify(input)}`).toBe(expected)
  }
}

function expectBoundWithoutGrowth(prog: TableProgram): void {
  const ip = repeatIp(prog)
  // A recovery REP has always been eight words. The guard reuses its formerly
  // unused separator-class slot; it does not mint a ninth operand.
  expect(rowWidth(prog, ip)).toBe(8)
  expect(prog.code[ip + 4], 'separator-less').toBe(-1)
  expect(prog.code[ip + 7], 'bound item class').toBeGreaterThanOrEqual(0)
}

describe('table REP optional-item first-set guard', () => {
  it('binds an already-pooled finite/nonnullable class in ip+7 at zero row/word cost', () => {
    const bound = finiteProgram('a')
    const unpooled = finiteProgram('z')
    const boundIp = repeatIp(bound)
    const unpooledIp = repeatIp(unpooled)

    expectBoundWithoutGrowth(bound)
    expect(rowWidth(unpooled, unpooledIp)).toBe(8)
    expect(unpooled.code[unpooledIp + 7]).toBe(-1)
    // Same grammar topology and row widths; only whether the item's exact class
    // was already available differs.
    expect(bound.code.length).toBe(unpooled.code.length)
    expect(boundIp).toBe(unpooledIp)
  })

  it('has a test-local RED plant for the structural assertion', () => {
    const prog = finiteProgram()
    const planted = { ...prog, code: [...prog.code] }
    planted.code[repeatIp(planted) + 7] = -1

    // This deliberately breaks only the cloned artifact. It proves the test is
    // live without mutating production source or relying on a semantic output
    // that a correct optional repeat must keep identical.
    expect(() => expectBoundWithoutGrowth(planted)).toThrow()
    expectBoundWithoutGrowth(prog)
  })

  it('declines nullable, unpooled, three-digit-class and separated items', () => {
    const nullable = encodeTable({
      Prime: choice(literal('a'), literal('b')),
      Entry: many(optional(literal('a'))),
    })
    expect(nullable.code[repeatIp(nullable) + 7]).toBe(-1)

    const unpooled = finiteProgram('z')
    expect(unpooled.code[repeatIp(unpooled) + 7]).toBe(-1)

    const manyClasses: Record<string, Combinator<unknown>> = {}
    for (let block = 0; block < 11; block++) {
      const arms = Array.from(
        { length: 10 },
        (_, i) => literal(String.fromCodePoint(0x100 + block * 10 + i)),
      ) as [Combinator<unknown>, ...Combinator<unknown>[]]
      manyClasses[`Prime${block}`] = choice(...arms)
    }
    const high = String.fromCodePoint(0x100 + 104)
    manyClasses.Entry = many(sequence(literal(high), literal('!')))
    const threeDigit = encodeTable(manyClasses)
    expect(threeDigit.cc.length).toBeGreaterThan(100)
    expect(threeDigit.code[repeatIp(threeDigit) + 7]).toBe(-1)

    const separated = encodeTable({
      Prime: choice(literal('a'), literal('b')),
      Entry: sepBy(literal('a'), literal(',')),
    })
    const sepIp = repeatIp(separated)
    expect(separated.code[sepIp + 4]).toBeGreaterThanOrEqual(0)
    const separatorClass = resolveTable(separated).cc[separated.code[sepIp + 7]!]!
    expect(separatorClass.ascii[','.charCodeAt(0)]).toBe(1)
    expect(separatorClass.ascii['a'.charCodeAt(0)]).toBe(0)
  })

  it('bypasses the guard for tolerant recovery and completions probes', () => {
    const item = sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/))
    const prog = encodeTable({
      Prime: choice(regex(/[a-z]+/), literal('@')),
      Entry: sequence(literal('{'), many(item), literal('}')),
    })
    expectBoundWithoutGrowth(prog)

    // Tolerant assembly must enter the item on an excluded '$' so recovery can
    // materialize its expected set and error span.
    expectAgreement(prog, ['{a:1$$b:2}', '{$$a:1}'], { tolerant: true })
    for (const entry of Object.values(drivers(prog))) {
      const r = run(entry, '{a:1$$b:2}', { tolerant: true })
      expect(r.ok).toBe(true)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]?.expected).toContain('/[a-z]+/')
    }

    const t = resolveTable(prog)
    const strictSource = emitAssemblySource(t, prog, {
      hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false,
    }).source
    const tolerantSource = emitAssemblySource(t, prog, {
      hostCst: false, trackLines: false, tolerant: true, coverage: false, probe: false,
    }).source
    expect(strictSource).toContain('ctx._probe===undefined')
    expect(tolerantSource).not.toContain('ctx._probe===undefined')

    // A probe-enabled assembly takes the ordinary child path. All three engines
    // retain the same probe/top-level failure state at the cursor.
    const probeProg = finiteProgram()
    for (const [name, entry] of Object.entries(drivers(probeProg))) {
      const ctx = createParseContext()
      ctx._probe = { offset: 0, best: null }
      const result = (entry as (input: string, pos: number, ctx: ParseContext) => {
        ok: boolean; value: unknown; span: { start: number; end: number }
      })('?', 0, ctx)
      expect(result, name).toEqual({ ok: true, value: [], span: { start: 0, end: 0 } })
      // The shipped engines feed completionsAt; exec.ts remains the recognition
      // reference and deliberately has no probe recording at its leaf sites.
      if (name === 'reference') expect(ctx._probe.best).toBeNull()
      else expect(ctx._probe.best?.expected).toEqual(['"a"'])
    }
  })

  it('preserves strict AST, trivia, expected and committed-failure behavior in all three engines', () => {
    const prog = finiteProgram()
    expectAgreement(prog, ['?', 'a!', 'a!a!?', 'a?'])
    expectAgreement(prog, ['a!  ?'], { trivia: regex(/\s+/) })

    const expectedProg = encodeTable({
      Prime: choice(literal('a'), literal('b')),
      Entry: sequence(many(literal('a')), literal('!')),
    })
    expectAgreement(expectedProg, ['?', 'aa?'])
    for (const entry of Object.values(drivers(expectedProg))) {
      const r = run(entry, '?')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.expected).toEqual(['"!"'])
    }

    const cut = dispatch(regex(/@[a-z]+/), when('@x', transform(literal('!'), () => '!')))
    const committed = encodeTable({
      Prime: choice(literal('@'), literal('#')),
      Entry: many(cut),
    })
    expectAgreement(committed, ['@x', '@x!@x'])
    for (const entry of Object.values(drivers(committed))) expect(run(entry, '@x').ok).toBe(false)
  })

  it('preserves strict CST materialization in emitted, closure and reference engines', () => {
    const prog = encodeTable({
      Prime: choice(literal('a'), literal('b')),
      Entry: many(node('Item', sequence(literal('a'), literal('!')))),
    }, { hostMode: 'cst' })
    expectBoundWithoutGrowth(prog)
    expectAgreement(prog, ['a!a!?', '?'], { build: cstBuildHost({ tags: true }) })

    // Prove the normal leg is genuinely emittable rather than silently falling
    // back to the closure assembly.
    const assembled = assemble(resolveTable(prog), prog, {
      hostCst: true, trackLines: false, tolerant: false, coverage: false, probe: false,
    })
    expect(assembled.emitRefusal).toBeUndefined()
  })
})
