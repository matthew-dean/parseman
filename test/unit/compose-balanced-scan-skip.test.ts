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
import { rules, balanced, regex, literal, sequence, parse } from '../../src/index.ts'
import { compileLinkableTable as compileLinkable } from '../../src/compiler/compile-linkable-table.ts'
import { compose } from '../../src/compiler/linker.ts'
import { serializeRuleMap, evalRuleMapIR } from '../../src/compiler/ir-serialize.ts'

const blockComment = sequence(literal('/*'), regex(/(?:[^*]|\*(?!\/))*/), literal('*/'))
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const sq = sequence(literal("'"), regex(/[^']*/), literal("'"))
const SCAN_SKIP = [blockComment, dq, sq]

type Result = { ok: boolean; span: { end: number } }
type Fn = (i: string, p: number, c: object) => Result

function lower(entries: ReadonlyArray<readonly [string, unknown]>): Fn {
  // Fuse through the public `compose()` — the table lowering has no separate
  // "link already-lowered pieces" step, so a one-grammar compose IS the fuse.
  return (compose([Object.fromEntries(entries as never)]) as unknown as Record<string, Fn>).Group!
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
