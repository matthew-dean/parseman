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
  keywords, label, skip, token, transform,
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

import { evalRuleMapIR } from '../../src/compiler/ir-serialize.ts'

function roundTrip(rm: ReadonlyArray<readonly [string, unknown]>, rule: string, inputs: string[]) {
  const src = serializeRuleMap(rm as never)
  expect(src, 'serializable').not.toBeNull()
  const entries = evalRuleMapIR(src!)
  // The re-lowered pieces must be STATICALLY fusable (callbacks inlined from
  // fnSrc/buildSrc) — a plain runtime callback would break emitFusedSource, the
  // macro path. fuseRules below tolerates them, so assert it explicitly.
  const pieces = compileLinkable(entries as never, '_t_')!
  expect(pieces.mfFns.length + pieces.buildFns.length, 'statically fusable (callbacks inlined)').toBe(0)
  const rebuilt = run(entries)
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

  it('a shared const that itself references a rule (must stay in the factory scope)', () => {
    const rm = Object.entries(rules((g: any) => {
      // `pair` is a shared const AND references g.Term — the const must be emitted
      // inside `rules((g) => {…})` where `g` is in scope, not hoisted above it.
      const pair = sequence(g.Term, literal(':'), g.Term)
      return { Doc: sequence(pair, many(sequence(literal(','), pair))), Term: regex(/[a-z]+/) }
    }))
    roundTrip(rm, 'Doc', ['a:b', 'a:b,c:d', 'x:y,z:w'])
  })

  it('nested trivia/parser scopes, optional, not, scanTo', () => {
    const ws = regex(/\s+/)
    const rm = Object.entries(rules((g: any) => ({
      Doc: parser({ trivia: ws }, sequence(g.Item, many(g.Item))),
      Item: sequence(optional(literal('-')), regex(/[a-z]+/), not(literal('!'))),
    })))
    roundTrip(rm, 'Doc', ['a', 'a b c', '-a  -b', 'a-'])
  })

  it('the remaining leaf/wrapper arms: keywords, oneOrMore, trivia, label, expect, skip, scanTo', () => {
    const rm = Object.entries(rules((g: any) => ({
      // keywords with both option branches (caseInsensitive + boundary); a
      // case-insensitive literal; oneOrMore; the trivia()/label()/expect()/skip()
      // wrapper arms; and a scanTo() that actually reaches the scanTo serializer.
      Doc: sequence(g.Kw, g.Digits, g.Named, g.Semi, g.Word, g.ToEnd),
      Kw: keywords(['if', 'else'], { caseInsensitive: true, boundary: '\\w' }),
      Digits: oneOrMore(regex(/[0-9]/)),
      Named: label('ident', regex(/[a-z]+/)),
      Semi: expectC(literal(';'), 'semicolon'),
      Word: skip(regex(/[a-z]+/), literal('_')),
      ToEnd: trivia(scanTo(literal('.'), { skip: [regex(/\s+/)], orEOF: true })),
      Tok: token(sequence(literal('!'), regex(/important/i))),
      Ci: literal('url(', { caseInsensitive: true }),
    })))
    roundTrip(rm, 'Kw', ['if', 'else', 'iffy'])
    roundTrip(rm, 'Digits', ['1', '123', 'x'])
    roundTrip(rm, 'Named', ['abc', '9'])
    roundTrip(rm, 'ToEnd', ['a b.', 'xyz', ''])
    roundTrip(rm, 'Tok', ['!important', '!IMPORTANT', '! important'])
    roundTrip(rm, 'Ci', ['url(', 'URL(', 'nope'])
  })

  it('returns null when a construct carries no static source (runtime transform fn)', () => {
    // A `transform` authored with a live fn (no captured `fnSrc`) can't be
    // serialized — the serializer throws Unserializable and the caller falls back
    // to lowered source, surfaced here as a null return.
    const rm = Object.entries(rules((g: any) => ({
      Doc: transform(regex(/[0-9]+/), (v: unknown) => v),
    })))
    expect(serializeRuleMap(rm as never)).toBeNull()
  })
})
