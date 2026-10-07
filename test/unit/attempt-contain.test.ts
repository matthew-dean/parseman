/**
 * `attempt(parser, { contain: true })` — a transaction that also contains
 * commitment.
 *
 * A selected `dispatch()` branch that fails is a COMMITTED failure, and a
 * committed failure ends every enclosing choice. That is the right default: once
 * the head has routed, no other arm can be the right reading. It is wrong where
 * two readings of one prefix are genuinely ambiguous and only a later token
 * decides — css-syntax-3 §5.4.4 reads a block item as a declaration and, when
 * that fails, re-reads it as a nested rule. If the first reading routes through a
 * dispatch, its committed failure would forbid the second reading. A contained
 * attempt reports that failure as an ordinary one at its entry instead.
 */
import { describe, expect, it } from 'vitest'
import {
  attempt, choice, dispatch, expect as required, literal, rules, run, sequence, when,
  type ParseContext,
} from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { compileLinkableTable } from '../../src/compiler/compile-linkable-table.ts'
import { evalRuleMapIR, serializeRuleMap } from '../../src/compiler/ir-serialize.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import { assertEnginesAgree } from '../parity/helpers/engine-parity.ts'

/* Reading one routes `k` through a dispatch whose selected branch then fails. */
const committingReading = () => sequence(literal('a'), dispatch(literal('k'), when('k', literal('x'))))
const otherReading = () => sequence(literal('a'), literal('k'), literal('y'))

describe('attempt(parser, { contain: true })', () => {
  it('without contain, a committed failure inside the attempt still ends the choice', () => {
    expect(assertEnginesAgree(choice(attempt(committingReading()), otherReading()), 'aky')).toEqual({
      ok: false, expected: ['"x"'], span: { start: 2, end: 2 }, committed: true,
    })
  })

  it('contains a committed failure, so the choice tries its next arm', () => {
    expect(assertEnginesAgree(choice(attempt(committingReading(), { contain: true }), otherReading()), 'aky')).toEqual({
      ok: true, value: ['a', 'k', 'y'], span: { start: 0, end: 3 },
    })
  })

  it('keeps the first reading when it succeeds', () => {
    expect(assertEnginesAgree(choice(attempt(committingReading(), { contain: true }), otherReading()), 'akx')).toEqual({
      ok: true, value: ['a', ['k', 'x']], span: { start: 0, end: 3 },
    })
  })

  it('reports a contained failure at its entry, uncommitted, with the inner expectation', () => {
    expect(assertEnginesAgree(sequence(literal('-'), attempt(committingReading(), { contain: true })), '-aky')).toEqual({
      ok: false, expected: ['"x"'], span: { start: 1, end: 1 },
    })
  })

  it('removes recovery diagnostics written inside the contained reading', () => {
    const grammar = choice(
      attempt(sequence(required(literal('a')), dispatch(literal('k'), when('k', literal('x')))), { contain: true }),
      otherReading(),
    )
    const errors: unknown[] = []
    const result = grammar.parse('aky', 0, { trackLines: false, _errors: errors } as unknown as ParseContext)
    expect(result).toMatchObject({ ok: true, value: ['a', 'k', 'y'] })
    expect(errors).toEqual([])
    expect(assertEnginesAgree(grammar, 'aky')).toMatchObject({ ok: true })
  })

  it('contains the commitment in the reference table driver', () => {
    const exec = (root: unknown) => execRules(encodeTable({ Root: root as never })).Root! as unknown as Parameters<typeof run>[0]
    expect(run(exec(choice(attempt(committingReading(), { contain: true }), otherReading())), 'aky')).toMatchObject({ ok: true, value: ['a', 'k', 'y'] })
    expect(run(exec(choice(attempt(committingReading()), otherReading())), 'aky')).toMatchObject({ ok: false })
  })

  it('survives macro lowering', () => {
    const source = `import { attempt, choice, dispatch, literal, sequence, when } from 'parseman' with { type: 'macro' }
const parser = choice(
  attempt(sequence(literal('a'), dispatch(literal('k'), when('k', literal('x')))), { contain: true }),
  sequence(literal('a'), literal('k'), literal('y')),
)`
    const transformed = transformMacro(source, 'attempt-contain-macro.ts', new Set(['parseman']))!
    expect(transformed.code).not.toContain("from 'parseman'")
    const parser = evalMacroModule<(input: string, pos: number, ctx: ParseContext) => unknown>(transformed.code, 'parser')
    expect(parser('aky', 0, { trackLines: false } as ParseContext)).toMatchObject({ ok: true, span: { start: 0, end: 3 } })
  })

  it('survives an IR round trip', () => {
    const rm = Object.entries(rules(() => ({
      Item: choice(attempt(committingReading(), { contain: true }), otherReading()),
    })))
    const src = serializeRuleMap(rm as never)
    expect(src).toContain('contain: true')
    const rebuilt = compileLinkableTable(evalRuleMapIR(src!) as never, '_t_')!.rules as unknown as Record<string, (i: string, p: number, c: object) => { ok: boolean }>
    expect(rebuilt.Item!('aky', 0, {})).toMatchObject({ ok: true })
  })

  it('rejects an option it does not know', () => {
    expect(() => attempt(literal('a'), { contain: 'yes' } as never)).toThrow(TypeError)
    expect(() => attempt(literal('a'), { cut: true } as never)).toThrow(TypeError)
  })
})
