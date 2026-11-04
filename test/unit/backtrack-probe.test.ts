import { describe, expect, it } from 'vitest'
import {
  choice, literal, many, not, peek, regex, rules, scanTo, sequence, trivia,
} from '../../src/index.ts'
import { backtrackProbe, type BacktrackEngine } from '../../src/analysis/backtrack.ts'
import { compileRuleMapRunnable } from '../../src/table/compile-rule-map.ts'
import { BacktrackRecorder, probeProgram } from '../../src/table/backtrack-probe.ts'
import type { Combinator } from '../../src/types.ts'
import { childSlots } from '../../src/table/child-slots.ts'
import { OP_ARMGATE, OP_NOT, OP_XFORM } from '../../src/table/ops.ts'

const ENGINES: readonly BacktrackEngine[] = ['interpreter', 'closure', 'emitted']

/** The counts on every engine, after checking each ran the engine it names. */
function countsOn(grammar: Record<string, unknown>, entry: string, input: string) {
  return ENGINES.map((engine) => {
    const probe = backtrackProbe(grammar, engine)
    expect(probe.engine, engine).toEqual({ ran: engine })
    const { result, counts } = probe.measure(entry, input)
    return { engine, ok: result.ok, unconsumedFrom: result.unconsumedFrom, counts }
  })
}

function sameOnEveryEngine(grammar: Record<string, unknown>, entry: string, input: string) {
  const [first, ...rest] = countsOn(grammar, entry, input)
  for (const r of rest) expect({ ...r, engine: first!.engine }, r.engine).toEqual(first)
  return first!
}

describe('backtrackProbe', () => {
  it('counts the arm a choice rewinds past, on all three engines alike', () => {
    const g = rules(() => ({
      Item: choice(
        sequence(regex(/[ab]+/), literal('x')),
        sequence(regex(/[a-z]/), regex(/[a-z]/), literal('y')),
      ),
    }))
    const r = sameOnEveryEngine(g, 'Item', 'aby')
    expect(r.ok).toBe(true)
    // `x` fails at 2, the second arm restarts at 0 and reads `ab` again.
    expect(r.counts).toEqual({
      rewinds: 1, bytesReread: 2, lookaheads: 0, lookaheadBytes: 0, regexLookarounds: 0, regexLookaroundBytes: 0,
    })
  })

  it('reports nothing for the same language, factored', () => {
    const g = rules(() => ({
      Item: sequence(regex(/[ab]+/), choice(literal('x'), literal('y'))),
    }))
    const r = sameOnEveryEngine(g, 'Item', 'aby')
    expect(r.ok).toBe(true)
    expect(r.counts.rewinds).toBe(0)
    expect(r.counts.bytesReread).toBe(0)
  })

  it('counts what each engine runs: the table factors a shared literal prefix the interpreter re-reads', () => {
    const g = rules(() => ({
      Item: choice(
        sequence(literal('a'), literal('b'), literal('x')),
        sequence(literal('a'), literal('b'), literal('y')),
      ),
    }))
    const [interpreter, closure, emitted] = countsOn(g, 'Item', 'aby')
    expect(interpreter!.counts).toMatchObject({ rewinds: 1, bytesReread: 2 })
    expect(closure!.counts).toMatchObject({ rewinds: 0, bytesReread: 0 })
    expect(emitted!.counts).toEqual(closure!.counts)
  })

  it('counts lookahead and regex lookaround apart from rewinds', () => {
    const g = rules(() => ({
      Item: sequence(not(literal('q')), peek(literal('f')), regex(/[a-z]+(?=;)/y), literal(';')),
    }))
    const r = sameOnEveryEngine(g, 'Item', 'foo;')
    expect(r.ok).toBe(true)
    expect(r.counts).toEqual({
      // `peek('f')` read one byte without consuming it; the regex looked one past `foo`.
      rewinds: 0, bytesReread: 0, lookaheads: 2, lookaheadBytes: 1, regexLookarounds: 1, regexLookaroundBytes: 1,
    })
  })

  it('counts a scan as one read, even where its skip set is a grammar rule', () => {
    const str = sequence(literal('"'), regex(/[^"]*/), literal('"'))
    const g = rules({ trivia: trivia(regex(/\s+/)), scanSkip: [str] }, g => ({
      Doc: many(choice(g.Str!, g.Stmt!)),
      Str: str,
      Stmt: scanTo(literal(';')),
    }))
    const r = sameOnEveryEngine(g, 'Doc', '"a" x "b;" y;')
    expect(r.ok).toBe(true)
    expect(r.counts.rewinds).toBe(0)
  })

  it('refuses to report when asked for a rule the grammar lacks', () => {
    const g = rules(() => ({ Item: literal('a') }))
    expect(() => backtrackProbe(g, 'closure').measure('Nope', 'a')).toThrow(/no rule "Nope"/)
  })
})

describe('probeProgram', () => {
  const g = rules({ trivia: trivia(regex(/\s+/)) }, () => ({
    Item: choice(sequence(literal('a'), not(literal('x'))), peek(regex(/b(?=c)/))),
  }))
  const entries: Array<[string, Combinator<unknown>]> = [['Item', g.Item as Combinator<unknown>]]

  it('rewrites a copy and leaves the program it was given untouched', () => {
    const { prog } = compileRuleMapRunnable(entries, { refusals: [] })!
    const code = [...prog.code]
    const fns = [...prog.fns]
    const probed = probeProgram(prog, new BacktrackRecorder())
    expect(probed.code.length).toBeGreaterThan(code.length)
    expect([...prog.code]).toEqual(code)
    expect([...prog.fns]).toEqual(fns)
  })

  it('wraps rows without a sequence, which would skip trivia and move where they end', () => {
    const { prog } = compileRuleMapRunnable(entries, { refusals: [] })!
    const probed = probeProgram(prog, new BacktrackRecorder())
    const added = new Set<number>()
    const seen = new Set<number>()
    const stack = Object.values(probed.rules)
    const kids: number[] = []
    while (stack.length > 0) {
      const ip = stack.pop()!
      if (seen.has(ip)) continue
      seen.add(ip)
      if (ip >= prog.code.length) added.add(probed.code[ip]!)
      kids.length = 0
      childSlots(probed.code, ip, kids)
      stack.push(...kids)
    }
    expect([...added].sort()).toEqual([OP_XFORM, OP_NOT, OP_ARMGATE].sort())
  })
})
