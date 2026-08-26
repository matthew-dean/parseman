import { describe, expect, it } from 'vitest'
import {
  adjacent,
  attempt,
  choice,
  dispatch,
  expect as expectParser,
  field,
  gate,
  keywords,
  label,
  leaf,
  literal,
  many,
  matches,
  node,
  not,
  oneOrMore,
  optional,
  otherwise,
  parser,
  peek,
  ref,
  regex,
  routed,
  scanTo,
  sepBy,
  sequence,
  token,
  transform,
  trivia,
  when,
  withCtx,
  type Combinator,
  type ParserDef,
} from '../../src/index.ts'
import {
  alwaysConsumes,
  capturesLeaf,
  classifyRuleMap,
  hasDirectBuildDef,
  hasNodeDef,
  mayCommitFailure,
  mayFail,
  mayLeavePartialCapture,
} from '../../src/analysis/commitment.ts'

function synthetic(def: ParserDef, inner: Combinator<unknown> = literal('x')): Combinator<unknown> {
  return {
    _tag: def.tag,
    _meta: inner._meta,
    _def: def,
    parse: (input, pos, ctx) => inner.parse(input, pos, ctx),
  }
}

const recover = (inner: Combinator<unknown>, sentinel: Combinator<unknown> = literal(';')) =>
  synthetic({ tag: 'recover', parser: inner, sentinel }, inner)
const unknown = () => synthetic({ tag: 'unknown' })
const throwingRef = () => ref<unknown>()
const builtNode = () => node('Built', literal('x'), children => children[0])
const structuralNode = () => node('Structural', literal('x'))

describe('commitment proof predicates', () => {
  it('proves fallibility only where failure can escape', () => {
    for (const total of [
      literal(''),
      trivia(regex(/\s*/)),
      optional(literal('x')),
      many(literal('x')),
      sepBy(literal('x'), literal(',')),
    ]) expect(mayFail(total)).toBe(false)

    const committed = dispatch(literal('x'), when('x', literal('!')))
    for (const fallible of [
      literal('x'),
      sepBy(literal('x'), literal(','), { min: 1 }),
      oneOrMore(literal('x')),
      sequence(literal(''), literal('x')),
      node('N', literal('x')),
      transform(literal('x'), value => value),
      label('x', literal('x')),
      field('x', literal('x')),
      expectParser(literal('x')),
      withCtx({}, literal('x')),
      parser({}, literal('x')),
      token(literal('x')),
      leaf(literal('x'), value => value),
      adjacent(),
      throwingRef(),
      optional(committed),
      many(committed),
      sepBy(literal('x'), committed),
    ]) expect(mayFail(fallible)).toBe(true)
  })

  it('distinguishes consuming success from zero-width success', () => {
    for (const consuming of [
      literal('x'),
      keywords(['if']),
      regex(/[a-z]+/),
      regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
      routed(),
      routed(literal('x')),
      sequence(literal(''), literal('x')),
      choice(literal('x'), literal('y')),
      oneOrMore(literal('x')),
      sepBy(literal('x'), literal(','), { min: 1 }),
      node('N', literal('x')),
      transform(literal('x'), value => value),
      label('x', literal('x')),
      field('x', literal('x')),
      withCtx({}, literal('x')),
      parser({}, literal('x')),
      token(literal('x')),
      leaf(literal('x'), value => value),
    ]) expect(alwaysConsumes(consuming)).toBe(true)

    for (const nullable of [
      literal(''),
      regex(/(?=x)/),
      regex(/\b/),
      routed(literal('')),
      choice(literal('x'), literal('')),
      sepBy(literal('x'), literal(',')),
      optional(literal('x')),
      expectParser(literal('x')),
      recover(literal('x')),
      adjacent(),
      throwingRef(),
    ]) expect(alwaysConsumes(nullable)).toBe(false)
  })

  it('detects partial capture only when a later failure can expose it', () => {
    for (const isolated of [
      literal('x'), regex(/x/), keywords(['x']), gate(() => true), adjacent(),
      not(literal('x')), peek(literal('x')), trivia(literal('x')), token(literal('x')),
      leaf(literal('x'), value => value), scanTo(literal(';')), unknown(), structuralNode(),
      choice(sequence(literal('x'), literal('!')), literal('y')), attempt(sequence(literal('x'), literal('!'))),
      optional(sequence(literal('x'), literal('!'))), many(sequence(literal('x'), literal('!'))),
      oneOrMore(sequence(literal('x'), literal('!'))), sepBy(literal('x'), literal(','), { min: 1 }),
    ]) expect(mayLeavePartialCapture(isolated)).toBe(false)

    expect(mayLeavePartialCapture(sequence(literal('x'), literal('!')))).toBe(true)
    expect(mayLeavePartialCapture(sequence(gate(() => true), literal('!')), new Set(), false)).toBe(false)
    expect(mayLeavePartialCapture(sequence(gate(() => true), literal('!')), new Set(), true)).toBe(true)
    expect(mayLeavePartialCapture(transform(sequence(literal('x'), literal('!')), value => value))).toBe(true)
    expect(mayLeavePartialCapture(recover(sequence(literal('x'), literal('!'))))).toBe(true)
    expect(mayLeavePartialCapture(throwingRef())).toBe(true)

    expect(mayLeavePartialCapture(dispatch(literal('x'), when('x', literal('!'))))).toBe(true)
    expect(mayLeavePartialCapture(dispatch(gate(() => true) as unknown as Combinator<string>, when('x', literal('!'))))).toBe(true)
    expect(mayLeavePartialCapture(dispatch(gate(() => true) as unknown as Combinator<string>, when(matches(/^x/), literal('!'))))).toBe(true)
    expect(mayLeavePartialCapture(dispatch(gate(() => true) as unknown as Combinator<string>, otherwise(literal('!'))))).toBe(true)
  })

  it('classifies constructs that capture a successful value', () => {
    for (const capturing of [
      literal('x'), regex(/x/), keywords(['x']), structuralNode(), token(literal('x')),
      routed(), leaf(literal('x'), value => value), sequence(gate(() => true), literal('x')),
      choice(gate(() => true), literal('x')), sepBy(gate(() => true), literal(',')),
      sepBy(gate(() => true), literal('x')), optional(literal('x')), attempt(literal('x')),
      transform(literal('x'), value => value), label('x', literal('x')), field('x', literal('x')),
      expectParser(literal('x')), withCtx({}, literal('x')), parser({}, literal('x')),
      recover(literal('x')), scanTo(literal(';')), throwingRef(),
      dispatch(gate(() => true) as unknown as Combinator<string>, when('x', literal('x'))),
      dispatch(gate(() => true) as unknown as Combinator<string>, when(matches(/^x/), literal('x'))),
      dispatch(gate(() => true) as unknown as Combinator<string>, otherwise(literal('x'))),
    ]) expect(capturesLeaf(capturing)).toBe(true)

    for (const silent of [gate(() => true), adjacent(), not(literal('x')), peek(literal('x')), trivia(literal('x')), unknown()]) {
      expect(capturesLeaf(silent)).toBe(false)
    }
  })

  it('finds structural nodes through every compound edge', () => {
    const n = structuralNode()
    for (const containing of [
      n, refWith(n), parser({}, n), trivia(n), token(n), leaf(n, value => value),
      label('n', n), field('n', n), optional(n), many(n), oneOrMore(n), not(n), peek(n),
      transform(n, value => value), sequence(literal('x'), n), choice(literal('x'), n),
      sepBy(literal('x'), n), scanTo(literal(';'), { skip: [n] }), recover(literal('x'), n),
      expectParser(n), withCtx({}, n),
      dispatch(literal('x'), when('x', n)),
      dispatch(literal('x'), when(matches(/^x/), n)),
      dispatch(literal('x'), otherwise(n)),
    ]) expect(hasNodeDef(containing)).toBe(true)

    expect(hasNodeDef(throwingRef())).toBe(false)
    expect(hasNodeDef(literal('x'))).toBe(false)
  })

  it('finds only direct semantic node builders through compound edges', () => {
    const b = builtNode()
    for (const containing of [
      b, refWith(b), parser({}, b), trivia(b), token(b), leaf(b, value => value),
      label('b', b), field('b', b), optional(b), many(b), oneOrMore(b), attempt(b),
      not(b), peek(b), withCtx({}, b), expectParser(b), transform(b, value => value),
      sequence(literal('x'), b), choice(literal('x'), b), sepBy(literal('x'), b),
      scanTo(literal(';'), { skip: [b] }), recover(literal('x'), b), routed(b),
      dispatch(literal('x'), when('x', b)),
      dispatch(literal('x'), when(matches(/^x/), b)),
      dispatch(literal('x'), otherwise(b)),
    ]) expect(hasDirectBuildDef(containing)).toBe(true)

    expect(hasDirectBuildDef(structuralNode())).toBe(false)
    expect(hasDirectBuildDef(throwingRef())).toBe(false)
    expect(hasDirectBuildDef(routed())).toBe(false)
  })

  it('tracks committed failure through swallowing and scanning constructs', () => {
    const cut = dispatch(literal('x'), when('x', literal('!')))
    for (const committing of [
      cut, choice(literal('x'), cut), sequence(literal('x'), cut), many(cut), oneOrMore(cut),
      optional(cut), attempt(cut), transform(cut, value => value), label('c', cut), field('c', cut),
      parser({}, cut), node('N', cut), sepBy(literal('x'), cut), token(cut), leaf(cut, value => value),
      withCtx({}, cut), scanTo(literal(';'), { skip: [cut] }), throwingRef(), unknown(),
    ]) expect(mayCommitFailure(committing)).toBe(true)

    for (const ordinary of [literal('x'), expectParser(cut), recover(cut), adjacent()]) {
      expect(mayCommitFailure(ordinary)).toBe(false)
    }

    const imported = throwingRef() as Combinator<unknown> & { _ruleName?: string }
    imported._ruleName = 'Imported'
    expect(mayCommitFailure(imported, new Set(), name =>
      name === 'Imported' ? literal('x') : undefined)).toBe(false)
    expect(mayCommitFailure(imported, new Set(), name =>
      name === 'Imported' ? cut : undefined)).toBe(true)
  })
})

describe('rule-map semantic classification', () => {
  it('separates direct builders and semantic reductions from recognition-only structure', () => {
    expect(classifyRuleMap([['Entry', builtNode()]])).toEqual({
      hasDirectBuilders: true,
      isRecognitionOnly: false,
    })
    expect(classifyRuleMap([['Entry', transform(literal('x'), value => value)]])).toEqual({
      hasDirectBuilders: false,
      isRecognitionOnly: false,
    })
    expect(classifyRuleMap([['Entry', choice({ gate: () => true, combinator: literal('x') }, literal('y'))]])).toEqual({
      hasDirectBuilders: false,
      isRecognitionOnly: false,
    })
    expect(classifyRuleMap([['Entry', withCtx({}, literal('x'))]])).toEqual({
      hasDirectBuilders: false,
      isRecognitionOnly: false,
    })
    expect(classifyRuleMap([['Entry', sequence(literal('x'), structuralNode())]])).toEqual({
      hasDirectBuilders: false,
      isRecognitionOnly: true,
    })
  })

  it('fails closed for an anonymous unresolved ref but treats a named ref as an external hole', () => {
    const anonymous = throwingRef()
    expect(classifyRuleMap([['Entry', anonymous]])).toEqual({
      hasDirectBuilders: false,
      isRecognitionOnly: false,
    })

    const named = throwingRef() as Combinator<unknown> & { _ruleName?: string }
    named._ruleName = 'External'
    expect(classifyRuleMap([['Entry', named]])).toEqual({
      hasDirectBuilders: false,
      isRecognitionOnly: true,
    })
  })
})

function refWith(parser: Combinator<unknown>): Combinator<unknown> {
  const slot = ref<unknown>()
  slot.define(parser)
  return slot
}
