import { describe, expect, it } from 'vitest'
import {
  choice, literal, many, not, peek, regex, rules, scanTo, sequence, trivia,
} from '../../src/index.ts'
import { backtrackProbe, backtrackProbeAssembled, type BacktrackProbe } from '../../src/analysis/backtrack.ts'
import { withEmittedAssembly } from '../../bench/emitted-assembly.ts'
import { compileRuleMapRunnable } from '../../src/table/compile-rule-map.ts'
import { BacktrackRecorder, probeCfg, probeProgram } from '../../src/table/backtrack-probe.ts'
import type { Combinator } from '../../src/types.ts'
import { childSlots } from '../../src/table/child-slots.ts'
import { OP_ARMGATE, OP_NOT, OP_XFORM } from '../../src/table/ops.ts'

const ENGINES = ['interpreter', 'closure', 'emitted'] as const

function probeOn(grammar: Record<string, unknown>, engine: typeof ENGINES[number]): Promise<BacktrackProbe> | BacktrackProbe {
  // The emitted engine comes from a build-time module: `backtrackProbe` never builds code.
  return engine === 'emitted'
    ? backtrackProbeAssembled(grammar, p => withEmittedAssembly(p, probeCfg(p)))
    : backtrackProbe(grammar, engine)
}

/** The counts on every engine, after checking each ran the engine it names. */
async function countsOn(grammar: Record<string, unknown>, entry: string, input: string) {
  const out = []
  for (const engine of ENGINES) {
    const probe = await probeOn(grammar, engine)
    expect(probe.engine, engine).toEqual({ ran: engine })
    const { result, counts } = probe.measure(entry, input)
    out.push({ engine, ok: result.ok, unconsumedFrom: result.unconsumedFrom, counts })
  }
  return out
}

async function sameOnEveryEngine(grammar: Record<string, unknown>, entry: string, input: string) {
  const [first, ...rest] = await countsOn(grammar, entry, input)
  for (const r of rest) expect({ ...r, engine: first!.engine }, r.engine).toEqual(first)
  return first!
}

describe('backtrackProbe', () => {
  it('counts the arm a choice rewinds past, on all three engines alike', async () => {
    const g = rules(() => ({
      Item: choice(
        sequence(regex(/[ab]+/), literal('x')),
        sequence(regex(/[a-z]/), regex(/[a-z]/), literal('y')),
      ),
    }))
    const r = await sameOnEveryEngine(g, 'Item', 'aby')
    expect(r.ok).toBe(true)
    // `x` fails at 2, the second arm restarts at 0 and reads `ab` again.
    expect(r.counts).toEqual({
      rewinds: 1, bytesReread: 2, lookaheads: 0, lookaheadBytes: 0, regexLookarounds: 0, regexLookaroundBytes: 0,
    })
  })

  it('reports nothing for the same language, factored', async () => {
    const g = rules(() => ({
      Item: sequence(regex(/[ab]+/), choice(literal('x'), literal('y'))),
    }))
    const r = await sameOnEveryEngine(g, 'Item', 'aby')
    expect(r.ok).toBe(true)
    expect(r.counts.rewinds).toBe(0)
    expect(r.counts.bytesReread).toBe(0)
  })

  it('counts what each engine runs: the table factors a shared literal prefix the interpreter re-reads', async () => {
    const g = rules(() => ({
      Item: choice(
        sequence(literal('a'), literal('b'), literal('x')),
        sequence(literal('a'), literal('b'), literal('y')),
      ),
    }))
    const [interpreter, closure, emitted] = await countsOn(g, 'Item', 'aby')
    expect(interpreter!.counts).toMatchObject({ rewinds: 1, bytesReread: 2 })
    expect(closure!.counts).toMatchObject({ rewinds: 0, bytesReread: 0 })
    expect(emitted!.counts).toEqual(closure!.counts)
  })

  it('counts lookahead and regex lookaround apart from rewinds', async () => {
    const g = rules(() => ({
      Item: sequence(not(literal('q')), peek(literal('f')), regex(/[a-z]+(?=;)/y), literal(';')),
    }))
    const r = await sameOnEveryEngine(g, 'Item', 'foo;')
    expect(r.ok).toBe(true)
    expect(r.counts).toEqual({
      // `peek('f')` read one byte without consuming it; the regex looked one past `foo`.
      rewinds: 0, bytesReread: 0, lookaheads: 2, lookaheadBytes: 1, regexLookarounds: 1, regexLookaroundBytes: 1,
    })
  })

  it('counts a scan as one read, even where its skip set is a grammar rule', async () => {
    const str = sequence(literal('"'), regex(/[^"]*/), literal('"'))
    const g = rules({ trivia: trivia(regex(/\s+/)), scanSkip: [str] }, g => ({
      Doc: many(choice(g.Str!, g.Stmt!)),
      Str: str,
      Stmt: scanTo(literal(';')),
    }))
    const r = await sameOnEveryEngine(g, 'Doc', '"a" x "b;" y;')
    expect(r.ok).toBe(true)
    expect(r.counts.rewinds).toBe(0)
  })

  it('refuses an option the emitted assembly does not serve', async () => {
    const g = rules(() => ({ Item: literal('a') }))
    const probe = await probeOn(g, 'emitted')
    expect(probe.measure('Item', 'a', { state: {} }).result.ok).toBe(true)
    expect(() => probe.measure('Item', 'a', { tolerant: true })).toThrow(/takes no tolerant/)
  })

  it('refuses to report when asked for a rule the grammar lacks', () => {
    const g = rules(() => ({ Item: literal('a') }))
    expect(() => backtrackProbe(g, 'closure').measure('Nope', 'a')).toThrow(/no rule "Nope"/)
  })
})

describe('code construction', () => {
  // A constructor that throws would be caught and fall back to closures, so count calls.
  function countingFunction(): { attempts: () => number; restore: () => void } {
    const real = globalThis.Function
    let attempts = 0
    const count = (): void => { attempts++ }
    globalThis.Function = new Proxy(real, {
      construct(target, args) { count(); return Reflect.construct(target, args) as object },
      apply(target, self, args) { count(); return Reflect.apply(target, self, args) as unknown },
    })
    return { attempts: () => attempts, restore: () => { globalThis.Function = real } }
  }
  const g = rules(() => ({
    Item: sequence(not(literal('q')), peek(literal('f')), regex(/[a-z]+(?=;)/y), literal(';')),
  }))

  it.each(['closure', 'interpreter'] as const)('the published probe builds no code on %s', (engine) => {
    const counter = countingFunction()
    try {
      expect(backtrackProbe(g, engine).measure('Item', 'foo;').counts.lookaheads).toBe(2)
    } finally { counter.restore() }
    expect(counter.attempts()).toBe(0)
  })

  it('a table program with no assembly inventory does not make it build any', () => {
    const { asm: _asm, ...bare } = compileRuleMapRunnable([['Item', g.Item as Combinator<unknown>]], { refusals: [] })!.prog
    const counter = countingFunction()
    try {
      expect(backtrackProbe(bare, 'closure').measure('Item', 'foo;').counts.lookaheads).toBe(2)
    } finally { counter.restore() }
    expect(counter.attempts()).toBe(0)
  })

  it('the emitted probe takes its engine from the imported module', async () => {
    let counter: ReturnType<typeof countingFunction> | undefined
    try {
      const probe = await backtrackProbeAssembled(g, async (p) => {
        const assembled = await withEmittedAssembly(p, probeCfg(p))
        counter = countingFunction()
        return assembled
      })
      expect(probe.engine).toEqual({ ran: 'emitted' })
      expect(probe.measure('Item', 'foo;').counts.lookaheads).toBe(2)
    } finally { counter?.restore() }
    expect(counter?.attempts()).toBe(0)
  })

  it('the emitted probe refuses a program with no assembly', async () => {
    const counter = countingFunction()
    try {
      await expect(backtrackProbeAssembled(g, async ({ asm: _asm, ...bare }) => bare)).rejects.toThrow(/no pre-compiled assembly/)
    } finally { counter.restore() }
    expect(counter.attempts()).toBe(0)
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
