/**
 * Gated-DISJOINT choice dispatch.
 *
 * A gated arm whose first-set is non-nullable and disjoint from every other arm
 * KEEPS its O(1) first-char dispatch slot: dispatch on the first char, then check
 * the gate INSIDE that branch. This is sound for ordered-PEG — a gated arm is
 * normally *skipped* so a later arm can retry the same position, but disjointness
 * means no later arm can match that first char, so "skip the gate then retry" is
 * exactly "dispatch to this arm and fail the choice if the gate is false".
 *
 * These tests pin down three-way parity (interpreter / compile() / macro) on
 * accept/reject + value across gate on/off, AND prove the optimization actually
 * fires (dispatch, not firstMatch) — while a nullable/overlapping gated choice
 * still falls back to firstMatch.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, choice, optional, withCtx, parse,
} from '../../src/index.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import type { GatedArm } from '../../src/index.ts'

type S = { inner?: boolean }

// A gated-disjoint choice: `&` gated on state.inner, plus disjoint non-nullable
// `x` and `[0-9]+` arms. First-sets {38} / {120} / {48..57} are pairwise disjoint
// and none is nullable → dispatch path.
function entry() {
  return choice(
    { gate: (s) => !!(s as S | undefined)?.inner, combinator: literal('&') } satisfies GatedArm<string>,
    literal('x'),
    regex(/[0-9]+/),
  )
}

// Build a macro-compiled parser fn from source. `fn(input, 0, ctx)` → ParseResult.
function macroFn(decls: string, varName: string) {
  const full =
    `import { literal, regex, choice, optional } from 'parseman' with { type: 'macro' }\n${decls}`
  const out = transformMacro(full, 'test.ts', new Set(['parseman']))
  if (!out) throw new Error('transformMacro returned null')
  // eslint-disable-next-line no-new-func
  return new Function(`${out.code}\nreturn ${varName}`)() as
    (input: string, pos: number, ctx: unknown) => { ok: boolean; value?: unknown; span: { start: number; end: number } }
}

const ENTRY_SRC = `const entry = choice(
  { gate: (s) => !!(s && s.inner), combinator: literal('&') },
  literal('x'),
  regex(/[0-9]+/),
)`

describe('gated-disjoint choice — interp ⇔ compiled ⇔ macro parity', () => {
  const macro = macroFn(ENTRY_SRC, 'entry')

  // For each (gateOn, input) assert all three paths agree on ok + value.
  const cases: Array<{ gateOn: boolean; input: string; ok: boolean; value?: unknown }> = [
    // gate ON (state.inner = true): '&' now accepted
    { gateOn: true, input: '&', ok: true, value: '&' },
    { gateOn: true, input: 'x', ok: true, value: 'x' },
    { gateOn: true, input: '5', ok: true, value: '5' },
    { gateOn: true, input: 'z', ok: false },
    // gate OFF (no state): '&' rejected, others unaffected
    { gateOn: false, input: '&', ok: false },
    { gateOn: false, input: 'x', ok: true, value: 'x' },
    { gateOn: false, input: '5', ok: true, value: '5' },
    { gateOn: false, input: 'z', ok: false },
  ]

  for (const c of cases) {
    it(`gate ${c.gateOn ? 'on' : 'off'}, input ${JSON.stringify(c.input)} → ${c.ok ? 'accept' : 'reject'}`, () => {
      // Interpreter: withCtx installs state for gate-on; bare for gate-off.
      const interpG = c.gateOn ? withCtx<S, unknown>({ inner: true }, entry()) : entry()
      const iR = parse(interpG, c.input)

      // compile(): same shape.
      const compG = c.gateOn ? withCtx<S, unknown>({ inner: true }, entry()) : entry()
      const cR = compile(compG).parse(c.input)

      // Macro: gate reads ctx.state — pass it as the 3rd arg.
      const mR = macro(c.input, 0, c.gateOn ? { state: { inner: true } } : {})

      expect(iR.ok, 'interp ok').toBe(c.ok)
      expect(cR.ok, 'compiled ok').toBe(c.ok)
      expect(mR.ok, 'macro ok').toBe(c.ok)
      if (c.ok) {
        expect(iR.ok && iR.value, 'interp value').toBe(c.value)
        expect(cR.ok && cR.value, 'compiled value').toBe(c.value)
        expect(mR.value, 'macro value').toBe(c.value)
      }
    })
  }
})

describe('gated-disjoint choice — optimization actually fires', () => {
  it('gated-disjoint choice compiles to first-char DISPATCH, not firstMatch', () => {
    const src = compile(entry()).source
    // Dispatch path: reads the first code point and branches on it.
    expect(src).toContain('input.codePointAt')
    // The gate is checked INSIDE the dispatched branch, against ctx.state.
    expect(src).toContain('(_ctx.state)')
    // firstMatch's per-arm success flag (`_crok`) must be ABSENT.
    expect(src).not.toContain('_crok')
  })

  it('macro emits the same dispatch (no interpreter fallback, gate present)', () => {
    const out = transformMacro(
      `import { literal, regex, choice } from 'parseman' with { type: 'macro' }\n${ENTRY_SRC}`,
      'test.ts', new Set(['parseman']),
    )
    expect(out).not.toBeNull()
    const code = out!.code
    expect(code).not.toContain("from 'parseman'") // fully compiled, no runtime fallback
    expect(code).toContain('codePointAt')
    expect(code).toContain('.inner') // the gate source was inlined
  })

  it('NON-disjoint gated choice (overlapping first-sets) still uses firstMatch', () => {
    const overlapping = choice(
      { gate: () => true, combinator: literal('aa') } satisfies GatedArm<string>,
      literal('ab'), // shares first char 'a' with the gated arm → NOT disjoint
    )
    const src = compile(overlapping).source
    expect(src).toContain('_crok') // firstMatch layout
  })

  it('NULLABLE gated choice (nullable arm) still uses firstMatch', () => {
    const nullable = choice(
      { gate: () => true, combinator: literal('x') } satisfies GatedArm<string>,
      optional(literal('y')), // matches empty → nullable → NOT dispatch-eligible
    )
    const src = compile(nullable).source
    expect(src).toContain('_crok') // firstMatch layout
  })
})

describe('gated-disjoint choice — multiple gated arms each dispatch with own gate', () => {
  type M = { mode?: 'a' | 'b' }
  function multi() {
    return choice(
      { gate: (s) => (s as M | undefined)?.mode === 'a', combinator: literal('alpha') } satisfies GatedArm<string>,
      { gate: (s) => (s as M | undefined)?.mode === 'b', combinator: literal('beta') } satisfies GatedArm<string>,
      literal('c'),
    )
  }

  it('each gated arm dispatches under its own predicate (interp + compiled)', () => {
    // mode a: 'alpha' accepted, 'beta' rejected (its gate is false).
    const inA = () => withCtx<M, unknown>({ mode: 'a' }, multi())
    expect(parse(inA(), 'alpha').ok).toBe(true)
    expect(compile(inA()).parse('alpha').ok).toBe(true)
    expect(parse(inA(), 'beta').ok).toBe(false)
    expect(compile(inA()).parse('beta').ok).toBe(false)

    // mode b: 'beta' accepted, 'alpha' rejected.
    const inB = () => withCtx<M, unknown>({ mode: 'b' }, multi())
    expect(parse(inB(), 'beta').ok).toBe(true)
    expect(compile(inB()).parse('beta').ok).toBe(true)
    expect(parse(inB(), 'alpha').ok).toBe(false)
    expect(compile(inB()).parse('alpha').ok).toBe(false)

    // ungated 'c' always accepted; no mode → both gated arms fail.
    expect(parse(multi(), 'c').ok).toBe(true)
    expect(compile(multi()).parse('c').ok).toBe(true)
    expect(parse(multi(), 'alpha').ok).toBe(false)
    expect(compile(multi()).parse('alpha').ok).toBe(false)

    // The dispatch fires (switch or if-chain) with two gate calls.
    const src = compile(multi()).source
    expect(src).not.toContain('_crok')
    expect((src.match(/\(_ctx\.state\)/g) ?? []).length).toBe(2)
  })
})
