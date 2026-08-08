import { describe, expect, it } from 'vitest'
import {
  adjacent,
  attempt,
  choice,
  dispatch,
  expect as expectParser,
  field,
  gate,
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
  parse,
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
  buildFieldMap,
  buildReadsFields,
  parserEnablesTriviaCapture,
  parserHasOwnFields,
  parserHasRootTriviaSite,
  parserHasTriviaSite,
} from '../../src/compiler/fields.ts'

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
const unresolvedRef = () => ref<unknown>()

function nodeDef(p: Combinator<unknown>): Extract<ParserDef, { tag: 'node' }> {
  expect(p._def.tag).toBe('node')
  return p._def as Extract<ParserDef, { tag: 'node' }>
}

describe('compiler field and trivia predicates', () => {
  it('only elides fields for builders with a confirmed arity below two', () => {
    expect(buildReadsFields(nodeDef(node('N', literal('x'))))).toBe(true)
    expect(buildReadsFields(nodeDef(node('N', literal('x'), children => children[0])))).toBe(false)
    expect(buildReadsFields(nodeDef(node('N', literal('x'), (_children, fields) => fields)))).toBe(true)
    expect(buildReadsFields(nodeDef(node('N', literal('x'), (...args) => args[1])))).toBe(true)
  })

  it('finds own fields across every compound edge and stops at nested nodes', () => {
    const f = field('value', literal('x'))
    const routedField = routed(f)
    const selectorField = field('selector', literal('x')) as Combinator<string>

    for (const containing of [
      f,
      sequence(literal('x'), f),
      choice(literal('y'), f),
      optional(f),
      many(f),
      oneOrMore(f),
      attempt(f),
      transform(f, value => value),
      trivia(f),
      token(f),
      leaf(f, value => value),
      label('f', f),
      expectParser(f),
      withCtx({}, f),
      not(f),
      peek(f),
      sepBy(literal('x'), f),
      parser({}, f),
      parser({ trivia: f }, literal('x')),
      scanTo(f),
      scanTo(literal(';'), { skip: [f] }),
      recover(f),
      recover(literal('x'), f),
      dispatch(selectorField, when('x', literal('!'))),
      dispatch(literal('x'), when('x', f)),
      dispatch(literal('x'), when(matches(/^x/), f)),
      dispatch(literal('x'), otherwise(f)),
      routedField,
      refWith(f),
    ]) expect(parserHasOwnFields(containing)).toBe(true)

    for (const fieldless of [
      literal('x'),
      adjacent(),
      gate(() => true),
      node('Nested', f),
      routed(),
      unresolvedRef(),
      unknown(),
    ]) expect(parserHasOwnFields(fieldless)).toBe(false)

    const built = node('N', routedField, (_children, fields) => fields)
    expect(parse(built, 'x')).toMatchObject({
      ok: true,
      value: { value: { value: 'x', span: { start: 0, end: 1 } } },
    })
  })

  it('distinguishes current-frame trivia sites from root-log sites', () => {
    const site = sequence(literal('x'), literal('y'))
    for (const containing of [
      site,
      many(literal('x')),
      oneOrMore(literal('x')),
      sepBy(literal('x'), literal(',')),
      scanTo(literal(';')),
      recover(literal('x')),
      optional(site),
      attempt(site),
      transform(site, value => value),
      trivia(site),
      label('site', site),
      expectParser(site),
      withCtx({}, site),
      not(site),
      peek(site),
      field('site', site),
      choice(literal('x'), site),
      dispatch(literal('x'), when('x', site)),
      dispatch(literal('x'), when(matches(/^x/), site)),
      dispatch(literal('x'), otherwise(site)),
      parser({}, site),
      routed(site),
      refWith(site),
      unresolvedRef(),
      unknown(),
    ]) {
      expect(parserHasTriviaSite(containing)).toBe(true)
      expect(parserHasRootTriviaSite(containing)).toBe(true)
    }

    for (const terminal of [
      literal('x'),
      regex(/x/),
      gate(() => true),
      adjacent(),
      token(site),
      leaf(site, value => value),
      routed(),
    ]) {
      expect(parserHasTriviaSite(terminal)).toBe(false)
      expect(parserHasRootTriviaSite(terminal)).toBe(false)
    }

    const nested = node('Nested', site)
    expect(parserHasTriviaSite(nested)).toBe(false)
    expect(parserHasRootTriviaSite(nested)).toBe(true)
  })

  it('finds explicit trivia capture through transparent and branching constructs', () => {
    const capture = parser({ captureTrivia: true }, literal('x'))
    const selectorCapture = capture as Combinator<string>
    for (const containing of [
      capture,
      parser({}, capture),
      sequence(literal('x'), capture),
      choice(literal('y'), capture),
      optional(capture),
      many(capture),
      oneOrMore(capture),
      attempt(capture),
      transform(capture, value => value),
      trivia(capture),
      token(capture),
      label('capture', capture),
      field('capture', capture),
      expectParser(capture),
      withCtx({}, capture),
      not(capture),
      peek(capture),
      sepBy(literal('x'), capture),
      scanTo(capture),
      scanTo(literal(';'), { skip: [capture] }),
      recover(capture),
      recover(literal('x'), capture),
      dispatch(selectorCapture, when('x', literal('!'))),
      dispatch(literal('x'), when('x', capture)),
      dispatch(literal('x'), when(matches(/^x/), capture)),
      dispatch(literal('x'), otherwise(capture)),
      routed(capture),
      refWith(capture),
    ]) expect(parserEnablesTriviaCapture(containing)).toBe(true)

    for (const hidden of [
      literal('x'),
      parser({}, literal('x')),
      node('Nested', capture),
      leaf(capture, value => value),
      routed(),
      unresolvedRef(),
      unknown(),
    ]) expect(parserEnablesTriviaCapture(hidden)).toBe(false)
  })
})

describe('buildFieldMap', () => {
  it('returns no map for no captures and promotes duplicate names to arrays', () => {
    expect(buildFieldMap(undefined)).toBeUndefined()
    expect(buildFieldMap([])).toBeUndefined()

    expect(buildFieldMap([
      { name: 'item', value: 'a', span: { start: 0, end: 1 } },
      { name: 'other', value: 'b', span: { start: 1, end: 2 } },
      { name: 'item', value: 'c', span: { start: 2, end: 3 } },
      { name: 'item', value: 'd', span: { start: 3, end: 4 } },
    ])).toEqual({
      item: [
        { value: 'a', span: { start: 0, end: 1 } },
        { value: 'c', span: { start: 2, end: 3 } },
        { value: 'd', span: { start: 3, end: 4 } },
      ],
      other: { value: 'b', span: { start: 1, end: 2 } },
    })
  })
})

function refWith(parser: Combinator<unknown>): Combinator<unknown> {
  const slot = ref<unknown>()
  slot.define(parser)
  return slot
}
