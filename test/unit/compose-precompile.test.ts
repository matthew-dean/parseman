/**
 * A grammar built with `compose()` ships the same compiled fast path as one built
 * with `composeLeaf()`: the default assembly precompiled into the artifact as
 * ordinary `_pf…` functions, so parsing never falls back to the closure engine.
 *
 * Two gaps kept real composed grammars off that path. The `compose()` build never
 * asked for the assembly, and the emitter had no lowering for two opcodes that
 * composed dialect grammars use: `ARMGATE` (`choice({ gate, combinator })`) and
 * `WITHCTX` (`withCtx(…)`). Each half is pinned here, together with the rule that
 * a refused assembly is a build warning rather than a silent fallback.
 */
import { describe, expect, it } from 'vitest'
import { choice, literal, run, sequence, withCtx } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { EMITTED_PARAMS, emitAssemblySource } from '../../src/table/emit-assembly.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import type { Combinator } from '../../src/types.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

type Entry = Parameters<typeof run>[0]
type ParseFn = (input: string, pos: number, ctx: object) => { ok: boolean; value?: unknown }
const STRICT = { hostCst: false, trackLines: false, tolerant: false, coverage: false, probe: false }

function precompiled(prog: TableProgram): TableProgram {
  const emitted = emitAssemblySource(resolveTable(prog), prog, STRICT)
  const factory = new Function(...EMITTED_PARAMS, emitted.source) as PrecompiledAssembly['factory']
  return { ...prog, asm: [{ key: 0, factory, plan: emitted.plan, reached: [...emitted.reached] }] }
}

function projection(entry: Entry, input: string, state: unknown): unknown {
  const r = run(entry, input, { state })
  return { ok: r.ok, value: r.value, span: r.span, expected: r.expected, unconsumedFrom: r.unconsumedFrom }
}

/** Interpreter, reference driver, closure assembly and precompiled assembly agree. */
function expectIdentity(grammar: Combinator<unknown>, inputs: readonly string[], states: readonly unknown[]): void {
  const prog = encodeTable({ Entry: grammar })
  const engines: Record<string, Entry> = {
    interpreter: grammar as Entry,
    reference: execRules(prog).Entry! as Entry,
    closure: tableRules({ ...prog, asm: [] }).Entry! as Entry,
    precompiled: tableRules(precompiled(prog)).Entry! as Entry,
  }
  for (const state of states) {
    for (const input of inputs) {
      const expected = projection(engines.interpreter!, input, state)
      for (const [name, entry] of Object.entries(engines)) {
        expect(projection(entry, input, state), `${name}: ${JSON.stringify(input)} @ ${JSON.stringify(state)}`)
          .toEqual(expected)
      }
    }
  }
}

/** Count `Function` construction while `body` runs. */
function functionCalls(body: () => void): number {
  const real = globalThis.Function
  let calls = 0
  const count = (): void => { calls++ }
  globalThis.Function = new Proxy(real, {
    construct(target, args, newTarget) { count(); return Reflect.construct(target, args, newTarget) as object },
    apply(target, thisArg, args) { count(); return Reflect.apply(target, thisArg, args) },
  })
  try { body() } finally { globalThis.Function = real }
  return calls
}

/** Enough rules that the composed table passes the 1,024-word precompile threshold. */
const RECOGNITION = `const recognition = rules(g => ({ ${
  Array.from({ length: 400 }, (_, i) => `R${i}: literal(${JSON.stringify(`value-${i}`)})`).join(',\n')
} }))`

const on = (s: unknown): boolean => (s as { on?: boolean } | undefined)?.on === true

describe('compose() precompiles its default assembly', () => {
  it('a large compose() artifact carries one precompiled assembly, exported or not', () => {
    const out = transformMacro(`
import { compose, literal, rules } from 'parseman' with { type: 'macro' }
${RECOGNITION}
const local = compose([recognition, rules(g => ({ Entry: g.R0 }))])
export const exported = compose([recognition, rules(g => ({ Entry: g.R1 }))])
`, 'compose-precompile.ts', new Set(['parseman']))
    expect(out?.warnings).toEqual([])
    expect(out?.code).not.toMatch(/\bcompose\s*\(/)
    // One assembly per compose() site; the plain `rules()` stays a closure table.
    expect(out?.code.match(/a:\[\{/g)).toHaveLength(2)
    expect(out?.code).toMatch(/function _pf\d+\(/)
    expect(out?.code).toMatch(/const recognition\s*=\s*\/\* @__PURE__ \*\/ tableRules\(\{\s*a:\[\],/)

    const { local, exported } = evalMacroModule<Record<string, Record<string, ParseFn>>>(out!.code, '{ local, exported }')
    expect(functionCalls(() => {
      expect(local!.Entry!('value-0', 0, {}).ok).toBe(true)
      expect(exported!.Entry!('value-1', 0, {}).ok).toBe(true)
      expect(exported!.Entry!('value-0', 0, {}).ok).toBe(false)
    })).toBe(0)
  })

  it('a composed grammar with gated arms and withCtx precompiles and parses by state', () => {
    const out = transformMacro(`
import { choice, compose, literal, rules, sequence, withCtx } from 'parseman' with { type: 'macro' }
${RECOGNITION}
export const grammar = compose([recognition, rules(g => ({
  Entry: choice(sequence(literal('['), withCtx({ on: true }, g.Item), literal(']')), g.Item),
  Item: choice({ gate: (s) => !!(s && s.on), combinator: literal('&') }, g.R0),
}))])
`, 'compose-precompile-gated.ts', new Set(['parseman']))
    expect(out?.warnings).toEqual([])
    expect(out?.code.match(/a:\[\{/g)).toHaveLength(1)

    const grammar = evalMacroModule<Record<string, ParseFn>>(out!.code, 'grammar')
    expect(functionCalls(() => {
      expect(grammar.Entry!('[&]', 0, {}).ok).toBe(true)
      expect(grammar.Entry!('&', 0, {}).ok).toBe(false)
      expect(grammar.Entry!('&', 0, { state: { on: true } }).ok).toBe(true)
      expect(grammar.Entry!('[value-0]', 0, {}).ok).toBe(true)
    })).toBe(0)
  })

  it('a grammar with a scan pool is still supercompiled, not just precompiled', () => {
    // The supercompiler splices its result over the emitted assembly only when it
    // re-emitted byte-identical source, and the source names the scan pool's
    // sites in order. It listed them in its own order, so any scan with a skip set
    // made the splice bail and the artifact shipped unjoined `_pf` pieces.
    const out = transformMacro(`
import { balanced, compose, literal, node, rules, scanTo, sequence } from 'parseman' with { type: 'macro' }
${RECOGNITION}
const grammar = compose([recognition, rules(g => ({
  Entry: node('Decl', sequence(
    g.R0, literal(':'), node('Value', scanTo(literal(';'), { skip: [balanced('(', ')')] })), literal(';'),
  )),
}))])
`, 'compose-precompile-scan.ts', new Set(['parseman']))
    expect(out?.warnings).toEqual([])
    expect(out?.code.match(/a:\[\{/g)).toHaveLength(1)
    expect(out?.code).toMatch(/\b_z\d+:\{/)

    const grammar = evalMacroModule<Record<string, ParseFn>>(out!.code, 'grammar')
    expect(grammar.Entry!('value-0:a(;)b;', 0, {}).ok).toBe(true)
    expect(grammar.Entry!('value-0:a(;b', 0, {}).ok).toBe(false)
  })

  it('an assembly the emitter refuses is a build warning, never a silent fallback', () => {
    // A greedy-classified choice (one regex arm subsuming literal arms) is still
    // unemittable. The artifact must say so rather than quietly ship closures.
    const out = transformMacro(`
import { choice, compose, literal, regex, rules } from 'parseman' with { type: 'macro' }
${RECOGNITION}
const grammar = compose([recognition, rules(g => ({ Entry: choice(regex(/[a-z]+/), literal('if')) }))])
`, 'compose-precompile-refused.ts', new Set(['parseman']))
    expect(out?.code).toContain('a:[],')
    expect(out?.warnings.some(w => /compose\(\): its precompiled assembly cannot emit OP_GREEDY/.test(w))).toBe(true)
  })
})

describe('the emitter lowers gated choice arms and withCtx', () => {
  it('ARMGATE on an ordered choice: a blocked arm is skipped and the next arm retries', () => {
    expectIdentity(
      choice({ gate: on, combinator: sequence(literal('a'), literal('b')) }, literal('a')),
      ['ab', 'a', 'x', ''],
      [undefined, { on: true }],
    )
  })

  it('ARMGATE on a dispatched choice: a blocked arm fails the choice with its expected set', () => {
    expectIdentity(
      choice({ gate: on, combinator: literal('&') }, literal('x')),
      ['&', 'x', 'y'],
      [undefined, { on: true }],
    )
  })

  it('WITHCTX installs a constant or derived state for its subtree and restores it after', () => {
    const gated = choice({ gate: on, combinator: literal('&') }, literal('x'))
    expectIdentity(
      sequence(withCtx({ on: true }, gated), gated),
      ['&&', '&x', 'xx'],
      [undefined, { on: true }],
    )
    expectIdentity(
      sequence(withCtx((s: { on?: boolean } | undefined) => ({ on: s?.on !== true }), gated), gated),
      ['&x', '&&', 'x&', 'xx'],
      [undefined, { on: true }],
    )
  })
})
