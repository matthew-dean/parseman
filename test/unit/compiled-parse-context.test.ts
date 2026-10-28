/**
 * `compile(g).parse(input, pos, ctx)` runs in the context it is given, as the
 * combinator's own `parse(input, pos, ctx)` does.
 */
import { describe, expect, it } from 'vitest'
import { choice, compile, gate, literal, regex, scanTo, sequence, rules } from '../../src/index.ts'
import type { Combinator, ParseContext } from '../../src/index.ts'

describe('compile().parse with a context', () => {
  it('reads the state of the context it is given', () => {
    const grammar = sequence(literal('a'), gate((state: unknown) => (state as { on?: boolean } | undefined)?.on === true))
    const compiled = compile(grammar)
    const on: ParseContext = { trackLines: false, state: { on: true } }
    expect(compiled.parse('a', 0, on).ok).toBe(true)
    expect(compiled.parse('a', 0, { trackLines: false, state: { on: false } }).ok).toBe(false)
    expect(compiled.parse('a', 0).ok).toBe(false)
    expect(grammar.parse('a', 0, on).ok).toBe(true)
  })

  it('answers as the combinator does at every position, with one context for every call', () => {
    const grammar = choice(regex(/[*+-](?=[ \t\n]|$)/), regex(/`{3,}/), literal('#'))
    const compiled = compile(grammar)
    const input = '- a\n``` b\n# c\n*x\n+\n'
    const shared: ParseContext = { trackLines: false }
    for (let pos = 0; pos <= input.length; pos++) {
      expect(compiled.parse(input, pos, shared)).toEqual(grammar.parse(input, pos, { trackLines: false }))
      expect(compiled.parse(input, pos, shared)).toEqual(compiled.parse(input, pos))
    }
  })

  it('keeps the scan-skip set of a grammar with a shared context', () => {
    const quoted = sequence(literal('"'), regex(/[^"]*/), literal('"'))
    const g = rules({ scanSkip: [quoted as Combinator<unknown>] }, () => ({ Item: scanTo(literal(';')) }))
    const compiled = compile(g.Item as Combinator<unknown>)
    const shared: ParseContext = { trackLines: false }
    const result = compiled.parse('a "x;y" b; rest', 0, shared)
    expect(result.ok && result.value).toBe('a "x;y" b')
    expect(compiled.parse('z;', 0, shared)).toMatchObject({ ok: true, value: 'z' })
  })
})
