import { afterAll, describe, expect, it, vi } from 'vitest'
import { adjacent, notAdjacent } from '../../src/combinators/adjacency.ts'
import { attempt } from '../../src/combinators/attempt.ts'
import { choice } from '../../src/combinators/choice.ts'
import { dispatch, otherwise, routed, startsWith, when } from '../../src/combinators/dispatch.ts'
import { expect as expectC } from '../../src/combinators/expect.ts'
import { gate } from '../../src/combinators/gate.ts'
import { parser } from '../../src/combinators/grammar.ts'
import { literal } from '../../src/combinators/literal.ts'
import { field, label, transform } from '../../src/combinators/map.ts'
import { node } from '../../src/combinators/node.ts'
import { not } from '../../src/combinators/not.ts'
import { peek } from '../../src/combinators/peek.ts'
import { regex } from '../../src/combinators/regex.ts'
import { many, optional, sepBy } from '../../src/combinators/repeat.ts'
import { scanTo } from '../../src/combinators/scanTo.ts'
import { sequence } from '../../src/combinators/sequence.ts'
import { leaf, token } from '../../src/combinators/token.ts'
import { withCtx } from '../../src/combinators/withCtx.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import type { Combinator } from '../../src/types.ts'

/**
 * The emitted assembly is the default and is exercised by the ordinary table
 * suite. This file deliberately reloads assemble.ts with emission disabled and
 * drives the independently maintained closure fallback through a broad opcode
 * and option matrix. Keeping the switch local avoids changing macro/size tests
 * that intentionally measure the default emitted artifact.
 */
const priorEmit = process.env.PM_TABLE_EMIT
afterAll(() => {
  if (priorEmit === undefined) delete process.env.PM_TABLE_EMIT
  else process.env.PM_TABLE_EMIT = priorEmit
})

async function closureRules(map: Record<string, Combinator<unknown>>, settings: Record<string, unknown> = {}) {
  process.env.PM_TABLE_EMIT = '0'
  vi.resetModules()
  const { tableRules } = await import('../../src/table/assemble.ts')
  const rules = tableRules(encodeTable(map, settings))
  if (priorEmit === undefined) delete process.env.PM_TABLE_EMIT
  else process.env.PM_TABLE_EMIT = priorEmit
  return rules
}

const value = (rule: unknown, input: string, opts?: Record<string, unknown>) =>
  run(rule as never, input, opts as never)

describe('closure assembler behavior matrix', () => {
  it('executes terminal, lookahead, mapping, scope, state, scan, token and recovery rows', async () => {
    const ws = regex(/[ \t]+/)
    const map: Record<string, Combinator<unknown>> = {
      Literals: choice(literal('a'), literal('bc'), literal('def'), literal('long')),
      Regex: regex(/[0-9]+/),
      CaseFold: literal('media', { caseInsensitive: true }),
      Look: sequence(peek(literal('a')), not(literal('z')), literal('a')),
      Maybe: sequence(optional(literal('a')), many(literal('b'))),
      List: sepBy(regex(/[a-z]/), literal(','), { min: 1, trailing: 'allow' }),
      Mapped: transform(label('word', regex(/[a-z]+/)), v => String(v).toUpperCase()),
      Leaf: leaf(sequence(literal('a'), literal('b')), (_v, span) => span.end),
      Token: token(sequence(literal('a'), literal('b'))),
      Scoped: parser({ trivia: ws }, sequence(literal('a'), literal('b'))) as Combinator<unknown>,
      Stateful: withCtx({ enabled: true }, sequence(gate(s => (s as { enabled?: boolean }).enabled === true), literal('x'))),
      Scan: sequence(scanTo(literal(';'), { orEOF: true }), optional(literal(';'))),
      Expected: sequence(literal('a'), expectC(literal('b'), 'b')),
      Attempt: choice(attempt(sequence(literal('a'), literal('!'))), literal('a')),
      Adjacent: sequence(literal('a'), adjacent(), literal('b')),
      Spaced: parser({ trivia: ws }, sequence(literal('a'), notAdjacent(), literal('b'))) as Combinator<unknown>,
    }
    const rules = await closureRules(map)

    for (const input of ['a', 'bc', 'def', 'long', 'x']) value(rules.Literals, input)
    for (const input of ['12', 'x']) value(rules.Regex, input)
    for (const input of ['MEDIA', 'other']) value(rules.CaseFold, input)
    for (const input of ['a', 'z']) value(rules.Look, input)
    for (const input of ['', 'a', 'abbb', 'bbb']) value(rules.Maybe, input)
    for (const input of ['a', 'a,b,', '']) value(rules.List, input)
    expect(value(rules.Mapped, 'abc').value).toBe('ABC')
    expect(value(rules.Leaf, 'ab').value).toBe(2)
    for (const input of ['ab', 'ax']) value(rules.Token, input)
    expect(value(rules.Scoped, 'a b').ok).toBe(true)
    expect(value(rules.Stateful, 'x').ok).toBe(true)
    for (const input of ['abc;', 'abc']) value(rules.Scan, input)
    expect(value(rules.Expected, 'a').ok).toBe(true)
    for (const input of ['a!', 'a', 'x']) value(rules.Attempt, input)
    expect(value(rules.Adjacent, 'ab').ok).toBe(true)
    expect(value(rules.Spaced, 'a b').ok).toBe(true)
  })

  it('executes dispatch, gated-choice and node variants under AST and CST hosts', async () => {
    const direct = node(
      'Pair',
      sequence(field('left', regex(/[a-z]+/)), literal(':'), field('right', regex(/[a-z]+/))),
      (children, fields, span) => ({ children, fields, span }),
      { captureTrivia: true },
    )
    const structural = node('Wrap', sequence(literal('('), direct, literal(')')), { collapse: false })
    const map: Record<string, Combinator<unknown>> = {
      Dispatch: dispatch(
        regex(/@[a-z]+/),
        when('@x', sequence(routed(), literal('!'))),
        when(startsWith('@pre'), sequence(routed(), literal('?'))),
        otherwise(sequence(routed(), literal('.'))),
      ) as Combinator<unknown>,
      Gated: choice(
        { gate: s => (s as { allow?: boolean }).allow === true, combinator: literal('a') },
        literal('b'),
      ),
      Direct: direct,
      Structural: structural,
    }
    const ast = await closureRules(map)
    for (const input of ['@x!', '@prefix?', '@other.', '@x']) value(ast.Dispatch, input)
    expect(value(ast.Gated, 'a', { state: { allow: true } }).ok).toBe(true)
    expect(value(ast.Gated, 'a', { state: { allow: false } }).ok).toBe(false)
    expect(value(ast.Direct, 'a:b').ok).toBe(true)

    const cst = await closureRules(map, { hostMode: 'cst' })
    const host = Object.assign(
      (type: string, children: readonly unknown[] | undefined, _fields: unknown, span: unknown, raw: readonly unknown[]) =>
        ({ type, children, span, raw }),
      { _parsemanCstOutput: true as const },
    )
    expect(value(cst.Structural, '(a:b)', { build: host }).ok).toBe(true)
    value(cst.Structural, '(a:)', { build: host, tolerant: true })
  })
})
