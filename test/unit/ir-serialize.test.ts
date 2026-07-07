/**
 * IR round-trip: a rule map serialized to a combinator-construction expression,
 * re-evaluated, and re-lowered must parse identically to the original — including
 * shared sub-combinators (one `const` reused across rules) and self-referential
 * ones (`balanced`'s internal `ref()`), the two cases that make naïve tree
 * serialization break.
 */
import { describe, it, expect } from 'vitest'
import {
  rules, regex, literal, sequence, choice, many, oneOrMore, optional, sepBy,
  not, scanTo, balanced, parser, trivia, expect as expectC, node,
} from '../../src/index.ts'
import { compileLinkable } from '../../src/compiler/codegen.ts'
import { fuseRules } from '../../src/compiler/linker.ts'
import { serializeRuleMap } from '../../src/compiler/ir-serialize.ts'

type RunMap = Record<string, (i: string, p: number, c: object) => { ok: boolean; span: { end: number } }>

// Materialize a rule map (as the fuse path does) into a callable parser map.
function run(rm: ReadonlyArray<readonly [string, unknown]>): RunMap {
  const pieces = compileLinkable(rm as never, '_t_')
  if (!pieces) throw new Error('not linkable')
  return fuseRules([pieces]) as unknown as RunMap
}

// Evaluate a serialized rule-map expression back into entries, with every
// combinator constructor in scope (as the runtime/plugin does at fuse time).
function evalRuleMap(src: string): ReadonlyArray<readonly [string, unknown]> {
  const ctorNames = ['rules', 'regex', 'literal', 'sequence', 'choice', 'many', 'oneOrMore', 'optional', 'sepBy', 'not', 'scanTo', 'parser', 'trivia', 'expect', 'node', 'ref', 'label', 'skip', 'keywords', 'transform']
  // eslint-disable-next-line no-new-func
  const ctors = ctorNames.map(n => (allCtors as Record<string, unknown>)[n])
  const map = new Function(...ctorNames, `return (${src})`)(...ctors)
  return Object.entries(map)
}

import * as allCtors from '../../src/index.ts'

function roundTrip(rm: ReadonlyArray<readonly [string, unknown]>, rule: string, inputs: string[]) {
  const src = serializeRuleMap(rm as never)
  expect(src, 'serializable').not.toBeNull()
  const rebuilt = run(evalRuleMap(src!))
  const original = run(rm)
  for (const input of inputs) {
    const a = original[rule]!(input, 0, {})
    const b = rebuilt[rule]!(input, 0, {})
    expect(b.ok, `ok mismatch on ${JSON.stringify(input)}`).toBe(a.ok)
    if (a.ok) expect(b.span.end, `end mismatch on ${JSON.stringify(input)}`).toBe(a.span.end)
  }
}

describe('IR serialize round-trip', () => {
  it('terminals, sequence/choice/repeat, and named rule refs', () => {
    const rm = Object.entries(rules((g: any) => ({
      Value: choice(g.Num, g.Word),
      Num: regex(/[0-9]+/),
      Word: regex(/[a-z]+/),
      List: sepBy(g.Value, literal(',')),
    })))
    roundTrip(rm, 'List', ['1', 'abc', '1,abc,2', 'a,b,c', ''])
  })

  it('a shared sub-combinator (one const referenced from several rules)', () => {
    const rm = Object.entries(rules((g: any) => ({
      // `g.Atom` reached from two rules — round trip must keep it shared, not duplicate.
      Sum: sequence(g.Atom, many(sequence(literal('+'), g.Atom))),
      Product: sequence(g.Atom, many(sequence(literal('*'), g.Atom))),
      Atom: choice(regex(/[0-9]+/), sequence(literal('('), g.Sum, literal(')'))),
    })))
    roundTrip(rm, 'Sum', ['1', '1+2', '1+2+3', '(1+2)', '1+(2+3)'])
    roundTrip(rm, 'Product', ['1*2', '(1+2)*3'])
  })

  it('a self-referential combinator: balanced() with its internal ref()', () => {
    const rm = Object.entries(rules((g: any) => ({
      // balanced is a shared const reused in two rules AND self-recursive inside.
      Parens: balanced('(', ')'),
      Pair: sequence(g.Parens, literal('='), g.Parens),
    })))
    roundTrip(rm, 'Parens', ['()', '(a)', '(a(b)c)', '((()))'])
    roundTrip(rm, 'Pair', ['()=()', '(a)=(b(c))'])
  })

  it('nested trivia/parser scopes, optional, not, scanTo', () => {
    const ws = regex(/\s+/)
    const rm = Object.entries(rules((g: any) => ({
      Doc: parser({ trivia: ws }, sequence(g.Item, many(g.Item))),
      Item: sequence(optional(literal('-')), regex(/[a-z]+/), not(literal('!'))),
    })))
    roundTrip(rm, 'Doc', ['a', 'a b c', '-a  -b', 'a-'])
  })
})
