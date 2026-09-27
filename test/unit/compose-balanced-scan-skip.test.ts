/**
 * Ambient `scanSkip` must reach a `balanced()` interior on EVERY surface, including
 * through `compose()`.
 *
 * `balanced()` records the obligation as `_balancedAmbient`, an own property held
 * deliberately outside `_def` so static analysis keeps seeing the eager interior.
 * Structural IR serialization therefore dropped it: the round trip emitted the raw
 * interior, the rebuilt object was an ordinary `transform`, codegen's ambient-rebuild
 * branch never fired, and the composed parser stopped at the first delimiter hidden
 * inside a string or comment — while the interpreter and a direct compile of the same
 * grammar did not. An interpreter-vs-compiled divergence in shipped code.
 */
import { describe, it, expect } from 'vitest'
import { rules, balanced, regex, literal, sequence, parse, run, scanTo } from '../../src/index.ts'
import { compose } from '../../src/compiler/linker.ts'
import { compile } from '../../src/table/compile.ts'
import { serializeRuleMap } from '../../src/compiler/ir-serialize.ts'
import { evalRuleMapIR } from '../../src/plugin/ir-eval.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule, macroImportRemoved } from '../helpers/eval-macro-module.ts'

const blockComment = sequence(literal('/*'), regex(/(?:[^*]|\*(?!\/))*/), literal('*/'))
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const sq = sequence(literal("'"), regex(/[^']*/), literal("'"))
const SCAN_SKIP = [blockComment, dq, sq]

type Result = { ok: boolean; span: { end: number } }
type Fn = (i: string, p: number, c: object) => Result

function lower(entries: ReadonlyArray<readonly [string, unknown]>): Fn {
  // Encode the rule map to one table, as a build re-lowering carried IR does.
  return compile(Object.fromEntries(entries) as Record<string, unknown>).Group as unknown as Fn
}

describe('compose() keeps ambient scanSkip inside a balanced() interior', () => {
  const group = balanced('(', ')')
  const rm = Object.entries(rules({ scanSkip: SCAN_SKIP }, () => ({ Group: group })))
  const ir = serializeRuleMap(rm as never, SCAN_SKIP as never)

  it('serializes the balanced as a constructor call, not as its lowered interior', () => {
    expect(ir, 'serializable').not.toBeNull()
    // The constructor call is what re-creates the ambient marker on the far side.
    expect(ir!).toContain('balanced("(", ")")')
    // The eager interior's content run — the tell that the marker was lost. Its stop
    // set is this pair's delimiters only; with the ambient units folded in it would
    // also exclude `/`, `"` and `'`.
    expect(ir!, 'eager interior leaked into the IR').not.toContain('[^()]+')
  })

  it.each([
    ['(e)', 3],
    ['(/* c */ e)', 11],
    ['(1px /* c */ + 2px)', 19],
    ["(')' e)", 7],
    ['("a)b" e)', 9],
    ['(a /* ) */ b)', 13],
  ])('%s parses identically on interpreter, compile and compose', (input, end) => {
    const composed = lower(evalRuleMapIR(ir!))
    const compiled = lower(rm)

    const i = parse(rm[0]![1] as never, input) as unknown as Result
    const c = compiled(input, 0, {})
    const z = composed(input, 0, {})

    expect(i.ok && i.span.end, 'interpreter').toBe(end)
    expect(c.ok && c.span.end, 'compiled').toBe(end)
    expect(z.ok && z.span.end, 'composed').toBe(end)
  })

  it('a per-call skip survives the round trip alongside the ambient set', () => {
    const backtick = sequence(literal('`'), regex(/[^`]*/), literal('`'))
    const g2 = balanced('(', ')', { skip: [backtick] })
    const rm2 = Object.entries(rules({ scanSkip: SCAN_SKIP }, () => ({ Group: g2 })))
    const ir2 = serializeRuleMap(rm2 as never, SCAN_SKIP as never)
    expect(ir2).not.toBeNull()
    expect(ir2!).toContain('balanced("(", ")", { skip: [')

    const composed = lower(evalRuleMapIR(ir2!))
    // The per-call unit hides a delimiter, and so does an ambient one.
    for (const [input, end] of [['(`)` e)', 7], ['("a)b" e)', 9]] as const) {
      const r = composed(input, 0, {})
      expect(r.ok && r.span.end, input).toBe(end)
    }
  })

  it('strict survives the round trip alongside per-call and ambient skip', () => {
    const backtick = sequence(literal('`'), regex(/[^`]*/), literal('`'))
    const strict = balanced('(', ')', { skip: [backtick], strict: true })
    const rmStrict = Object.entries(rules({ scanSkip: SCAN_SKIP }, () => ({ Group: strict })))
    const irStrict = serializeRuleMap(rmStrict as never, SCAN_SKIP as never)
    expect(irStrict).not.toBeNull()
    expect(irStrict!).toContain('strict: true')

    const composed = lower(evalRuleMapIR(irStrict!))
    expect(composed('(`)` e)', 0, {}).ok).toBe(true)
    expect(composed('(unfinished', 0, {}).ok).toBe(false)
  })

  it('an unfinished strict skipper cannot swallow an outer recovery boundary after compose', () => {
    const body = scanTo(literal('`'), {
      recoverAt: literal(';'),
      skip: [balanced('(', ')', { strict: true })],
    })
    const local = rules(() => ({ Body: body }))
    const runtime = compose([local]) as unknown as Record<string, unknown>

    const source = 'fn(unclosed; second: `good`;'
    const interpreted = parse(body, source) as unknown as Result & { value?: unknown }
    const composed = run(runtime.Body as never, source) as unknown as Result & { value?: unknown }

    for (const result of [interpreted, composed]) {
      expect(result.ok).toBe(true)
      expect(result.span.end).toBe(11)
      expect(result.value).toBe('fn(unclosed')
    }

    const macroSource = `import { balanced, compose, literal, rules, scanTo } from 'parseman' with { type: 'macro' }
const base = rules(g => ({ Filler: literal('#') }))
export const grammar = compose([base, rules(g => ({
  Body: scanTo(literal('\`'), {
    recoverAt: literal(';'),
    skip: [balanced('(', ')', { strict: true })],
  }),
}))])`
    const transformed = transformMacro(macroSource, '/pkg/strict-balanced-compose.ts', new Set(['parseman']))
    expect(transformed).not.toBeNull()
    expect(transformed!.warnings).toEqual([])
    expect(macroImportRemoved(transformed!.code), 'macro must not fall back to runtime compose').toBe(true)

    const macro = evalMacroModule<Record<string, Fn>>(transformed!.code, 'grammar')
    const emitted = macro.Body!(source, 0, {}) as Result & { value?: unknown }
    expect(emitted.ok).toBe(true)
    expect(emitted.span.end).toBe(11)
    expect(emitted.value).toBe('fn(unclosed')
  })

  it('raw: true stays structural — it opts out of ambient resolution', () => {
    const raw = balanced('(', ')', { raw: true })
    const rmRaw = Object.entries(rules({ scanSkip: SCAN_SKIP }, () => ({ Group: raw })))
    const irRaw = serializeRuleMap(rmRaw as never, SCAN_SKIP as never)
    expect(irRaw).not.toBeNull()
    expect(irRaw!, 'raw balanced must not round-trip as an ambient-aware balanced()').not.toContain('balanced(')

    // A raw balanced stops at a delimiter inside a string — on every surface.
    const composed = lower(evalRuleMapIR(irRaw!))
    expect(composed('("a)b" e)', 0, {}).span.end).toBe(4)
    expect((parse(rmRaw[0]![1] as never, '("a)b" e)') as unknown as Result).span.end).toBe(4)
  })
})
