import { describe, expect, it } from 'vitest'
import { literal } from '../../src/index.ts'
import { run as runTabled } from '../../src/functional/run-tabled.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { compile } from '../../src/table/compile.ts'
import { compileRuleMap, compileRuleMapRunnable } from '../../src/table/compile-rule-map.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableVariants } from '../../src/table/fold.ts'
import { foldPrograms } from '../../src/table/program.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

type ParseFn = (input: string, pos: number, ctx: object) => { ok: boolean }

/** Count construction, not a source spelling: the call used to live in the driver. */
function functionCalls(body: () => void): number {
  const real = globalThis.Function
  let calls = 0
  const proxy = new Proxy(real, {
    construct(target, args, newTarget) {
      calls++
      return Reflect.construct(target, args, newTarget) as object
    },
    apply(target, thisArg, args) {
      calls++
      return Reflect.apply(target, thisArg, args)
    },
  })
  globalThis.Function = proxy
  try {
    body()
  } finally {
    globalThis.Function = real
  }
  return calls
}

describe('compiler-created tables use the canonical compact closure artifact', () => {
  it('runtime compile has the same explicit empty inventory macro output carries', () => {
    const compiled = compile(literal('ok'))
    expect(compiled.inlineExpression).toContain('a:[],')
    expect(functionCalls(() => {
      expect(compiled.parse('ok').ok).toBe(true)
    })).toBe(0)
  })

  it('both rule-map compiler entry points stamp their program before assembly', () => {
    const entries = [['Entry', literal('ok')]] as const
    const printable = compileRuleMap(entries)
    const runnable = compileRuleMapRunnable(entries)
    expect(printable).not.toBeNull()
    expect(runnable).not.toBeNull()
    if (!printable || !runnable) return

    expect(printable.prog.asm).toEqual([])
    expect(runnable.prog.asm).toEqual([])
    expect(printable.replacement).toContain('a:[],')
    expect(functionCalls(() => {
      expect((printable.rules.Entry! as unknown as ParseFn)('ok', 0, {}).ok).toBe(true)
      expect((runnable.rules.Entry! as unknown as ParseFn)('ok', 0, {}).ok).toBe(true)
    })).toBe(0)
  })

  it('the public combinator run route is closure-stamped too', () => {
    expect(functionCalls(() => {
      expect(runTabled(literal('ok') as never, 'ok').ok).toBe(true)
    })).toBe(0)
  })

  it('an in-memory folded artifact gets the same stamp as an emitted fold', () => {
    const folded = foldPrograms({ plain: encodeTable({ Entry: literal('ok') }) }, 'plain')
    expect(folded.base.asm).toEqual([])
    expect(functionCalls(() => {
      expect((tableVariants(folded, 'plain').Entry! as unknown as ParseFn)('ok', 0, {}).ok).toBe(true)
    })).toBe(0)
  })

  it('a real macro replacement has the same wire policy and never constructs code while parsing', () => {
    const out = transformMacro(`
import { literal, rules } from 'parseman' with { type: 'macro' }
const grammar = rules(g => ({ Entry: literal('ok') }))
`, 'canonical-closure.ts', new Set(['parseman']))
    expect(out?.warnings).toEqual([])
    expect(out?.code).toContain('a:[],')

    // Module evaluation itself needs the test harness's Function constructor;
    // the assertion starts only after it has produced the macro artifact.
    const entry = evalMacroModule<ParseFn>(out!.code, 'grammar.Entry')
    expect(functionCalls(() => {
      expect(entry('ok', 0, {}).ok).toBe(true)
    })).toBe(0)
  })

  it('precompiles exactly one terminal composeLeaf default artifact once the table is large', () => {
    const recognitionRules = Array.from(
      { length: 400 },
      (_, i) => `R${i}: literal(${JSON.stringify(`value-${i}`)})`,
    ).join(',\n')
    const out = transformMacro(`
import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
const recognition = rules(g => ({ ${recognitionRules} }))
const grammar = composeLeaf([recognition, rules(g => ({ Entry: g.R0 }))])
`, 'canonical-compose-leaf.ts', new Set(['parseman']))
    expect(out?.warnings).toEqual([])
    expect(out?.code.match(/a:\[\{/g)).toHaveLength(1)
    expect(out?.code).toMatch(/const recognition\s*=\s*\/\* @__PURE__ \*\/ tableRules\(\{\s*a:\[\],/)

    const entry = evalMacroModule<ParseFn>(out!.code, 'grammar.Entry')
    expect(functionCalls(() => {
      expect(entry('value-0', 0, {}).ok).toBe(true)
    })).toBe(0)
  })

  it('keeps small, tracked, and CST precompile requests on the compact closure artifact', () => {
    const entries = [['Entry', literal('ok')]] as const
    const request = { precompileDefault: true } as const
    const small = compileRuleMap(entries)
    const tracked = compileRuleMap(entries, { trackLines: true })
    const cst = compileRuleMap(entries, { hostMode: 'cst' })
    expect(small?.replacementWithMetadata('{}', request)).toContain('a:[],')
    expect(tracked?.replacementWithMetadata('{}', request)).toContain('a:[],')
    expect(cst?.replacementWithMetadata('{}', request)).toContain('a:[],')
  })

  it('a macro round-trip preserves a descriptor-backed sequence projection', () => {
    const out = transformMacro(`
import { literal, rules, sequence, transform } from 'parseman' with { type: 'macro' }
const grammar = rules(g => ({
  Entry: transform(sequence(literal('left'), literal('right')), ([, value]) => value)
}))
`, 'canonical-projection.ts', new Set(['parseman']))
    expect(out?.warnings).toEqual([])
    expect(out?.code).toContain('a:[],')

    const entry = evalMacroModule<(input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }>(out!.code, 'grammar.Entry')
    expect(functionCalls(() => {
      expect(entry('leftright', 0, {})).toMatchObject({ ok: true, value: 'right' })
    })).toBe(0)
  })
})
