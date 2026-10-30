/**
 * The precompiled table assembly covers the opcodes real composed grammars use,
 * and a build that asked for one never silently ships the closure engine instead.
 *
 * - `ARMGATE` (`choice({ gate, combinator })`) and `WITHCTX` (`withCtx(…)`) are
 *   lowered by the emitter, site for site with the closure assembler.
 * - The supercompiler names the scan pool's sites in the emitter's order, so a
 *   grammar with a scan skip set is joined rather than shipped as loose pieces.
 * - An assembly the emitter refuses is a build warning naming the construct.
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

describe('the composeLeaf() precompiled assembly', () => {
  it('a leaf with gated arms and withCtx precompiles and parses by state', () => {
    const out = transformMacro(`
import { choice, composeLeaf, literal, rules, sequence, withCtx } from 'parseman' with { type: 'macro' }
${RECOGNITION}
export const grammar = composeLeaf([recognition, rules(g => ({
  Entry: choice(sequence(literal('['), withCtx({ on: true }, g.Item), literal(']')), g.Item),
  Item: choice({ gate: (s) => !!(s && s.on), combinator: literal('&') }, g.R0),
}))])
`, 'leaf-precompile-gated.ts', new Set(['parseman']))
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
import { balanced, composeLeaf, literal, node, rules, scanTo, sequence } from 'parseman' with { type: 'macro' }
${RECOGNITION}
const grammar = composeLeaf([recognition, rules(g => ({
  Entry: node('Decl', sequence(
    g.R0, literal(':'), node('Value', scanTo(literal(';'), { skip: [balanced('(', ')')] })), literal(';'),
  )),
}))])
`, 'leaf-precompile-scan.ts', new Set(['parseman']))
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
import { choice, composeLeaf, literal, regex, rules } from 'parseman' with { type: 'macro' }
${RECOGNITION}
const grammar = composeLeaf([recognition, rules(g => ({ Entry: choice(regex(/[a-z]+/), literal('if')) }))])
`, 'leaf-precompile-refused.ts', new Set(['parseman']))
    expect(out?.code).toContain('a:[],')
    expect(out?.warnings.some(w => /composeLeaf\(\): its precompiled assembly cannot emit OP_GREEDY/.test(w))).toBe(true)
    // The refusal costs the assembly only: the module still lowers completely.
    expect(out?.warnings.some(w => w.includes('running via the interpreter'))).toBe(false)
    expect(out?.code).not.toContain("from 'parseman'")
  })

  it('a refused assembly beside a ref() cluster still strips the cluster\'s define()', () => {
    // A module marked unresolved keeps its `x.define(…)` statements while `x` itself
    // becomes a compiled parser with no `define`, so importing the module throws.
    const out = transformMacro(`
import { choice, composeLeaf, literal, optional, ref, regex, rules, sequence } from 'parseman' with { type: 'macro' }
${RECOGNITION}
const item = ref()
item.define(sequence(literal('['), optional(item), literal(']')))
export const brackets = item
export const grammar = composeLeaf([recognition, rules(g => ({ Entry: choice(regex(/[a-z]+/), literal('if')) }))])
`, 'leaf-precompile-refused-ref.ts', new Set(['parseman']))
    expect(out?.warnings.some(w => /cannot emit OP_GREEDY/.test(w))).toBe(true)
    expect(out?.code).not.toMatch(/^item\.define\(/m)
    const { brackets, grammar } = evalMacroModule<Record<string, ParseFn | Record<string, ParseFn>>>(out!.code, '{ brackets, grammar }')
    expect((brackets as ParseFn)('[[]]', 0, {}).ok).toBe(true)
    expect((grammar as Record<string, ParseFn>).Entry!('if', 0, {}).ok).toBe(true)
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
