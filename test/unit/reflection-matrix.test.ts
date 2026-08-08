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
  GRAMMAR_REFLECTION,
  collectGrammarReflection,
  grammarReflectionOf,
  grammarReflectionSource,
  mergeGrammarReflections,
} from '../../src/cst/reflection.ts'
import { attachGrammarReflection } from '../../src/cst/reflection-attach.ts'

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

describe('grammar reflection', () => {
  it('collects nodes through every combinator edge', () => {
    const n = (type: string) => node(type, literal(type), { tags: ['Nested'] })
    const triviaNode = n('GrammarTrivia')
    const selector = n('Selector') as Combinator<string>
    const entries: Array<readonly [string, Combinator<unknown>]> = [
      ['Sequence', sequence(literal('x'), n('Sequence'))],
      ['Choice', choice(literal('x'), n('Choice'))],
      ['DispatchSelector', dispatch(selector, when('Selector', literal('x')))],
      ['DispatchCase', dispatch(literal('x'), when('x', n('DispatchCase')))],
      ['DispatchMatcher', dispatch(literal('x'), when(matches(/^x/), n('DispatchMatcher')))],
      ['DispatchOtherwise', dispatch(literal('x'), otherwise(n('DispatchOtherwise')))],
      ['Many', many(n('Many'))],
      ['OneOrMore', oneOrMore(n('OneOrMore'))],
      ['Optional', optional(n('Optional'))],
      ['Attempt', attempt(n('Attempt'))],
      ['Transform', transform(n('Transform'), value => value)],
      ['Trivia', trivia(n('Trivia'))],
      ['Token', token(n('Token'))],
      ['Leaf', leaf(n('Leaf'), value => value)],
      ['Label', label('node', n('Label'))],
      ['Field', field('node', n('Field'))],
      ['Not', not(n('Not'))],
      ['Peek', peek(n('Peek'))],
      ['WithCtx', withCtx({}, n('WithCtx'))],
      ['Expect', expectParser(n('Expect'))],
      ['Grammar', parser({ trivia: triviaNode }, n('Grammar'))],
      ['SepItem', sepBy(n('SepItem'), literal(','))],
      ['SepSeparator', sepBy(literal('x'), n('SepSeparator'))],
      ['ScanSentinel', scanTo(n('ScanSentinel'))],
      ['ScanSkip', scanTo(literal(';'), { skip: [n('ScanSkip')] })],
      ['Routed', routed(n('Routed'))],
      ['RecoverInner', recover(n('RecoverInner'))],
      ['RecoverSentinel', recover(literal('x'), n('RecoverSentinel'))],
      ['TerminalLiteral', literal('x')],
      ['TerminalRegex', regex(/x/)],
      ['TerminalGate', gate(() => true)],
      ['TerminalAdjacent', adjacent()],
      ['Unknown', unknown()],
      ['Anonymous', node(literal('x'))],
    ]

    const reflection = collectGrammarReflection(entries)
    const types = reflection.nodes.map(entry => entry.type)
    expect(types).toEqual([
      'Sequence', 'Choice', 'Selector', 'DispatchCase', 'DispatchMatcher',
      'DispatchOtherwise', 'Many', 'OneOrMore', 'Optional', 'Attempt',
      'Transform', 'Trivia', 'Token', 'Leaf', 'Label', 'Field', 'Not',
      'Peek', 'WithCtx', 'Expect', 'Grammar', 'GrammarTrivia', 'SepItem',
      'SepSeparator', 'ScanSentinel', 'ScanSkip', 'Routed', 'RecoverInner',
      'RecoverSentinel',
    ])
    expect(reflection.nodes.every(entry => entry.tags.includes('Nested'))).toBe(true)
  })

  it('merges duplicate node declarations and tags without changing first-seen order', () => {
    const reflection = collectGrammarReflection([
      ['A', node('Same', literal('a'), { tags: ['First', 'Shared'] })],
      ['B', node('Other', literal('b'))],
      ['C', node('Same', literal('c'), { tags: ['Shared', 'Last'] })],
      ['D', node('Same', literal('d'))],
    ])
    expect(reflection).toEqual({
      nodes: [
        { type: 'Same', tags: ['First', 'Shared', 'Last'] },
        { type: 'Other', tags: [] },
      ],
    })

    expect(mergeGrammarReflections([
      reflection,
      { nodes: [{ type: 'Other', tags: ['Second'] }, { type: 'Third', tags: ['New'] }] },
      { nodes: [{ type: 'Same', tags: ['Last', 'Merged'] }] },
    ])).toEqual({
      nodes: [
        { type: 'Same', tags: ['First', 'Shared', 'Last', 'Merged'] },
        { type: 'Other', tags: ['Second'] },
        { type: 'Third', tags: ['New'] },
      ],
    })
  })

  it('controls lazy traversal and fails closed on unresolved lazy thunks', () => {
    const nested = ref<unknown>()
    nested.define(node('NestedLazy', literal('x')))
    const outer = ref<unknown>()
    outer.define(sequence(node('DirectAfterResolve', literal('x')), nested))

    expect(collectGrammarReflection([['Outer', outer]])).toEqual({
      nodes: [
        { type: 'DirectAfterResolve', tags: [] },
        { type: 'NestedLazy', tags: [] },
      ],
    })
    expect(collectGrammarReflection([['Outer', outer]], { followLazy: false })).toEqual({
      nodes: [{ type: 'DirectAfterResolve', tags: [] }],
    })
    expect(collectGrammarReflection([['Missing', ref()]])).toEqual({ nodes: [] })
    expect(collectGrammarReflection([['Missing', ref()]], { followLazy: false })).toEqual({ nodes: [] })
  })

  it('attaches non-enumerable replaceable reflection and emits stable source', () => {
    const grammar = { Entry: literal('x') }
    const first = { nodes: [{ type: 'Entry', tags: ['Root'] }] }
    expect(attachGrammarReflection(grammar, first)).toBe(grammar)
    expect(grammarReflectionOf(grammar)).toBe(first)
    expect(Object.keys(grammar)).toEqual(['Entry'])
    expect(Object.getOwnPropertyDescriptor(grammar, GRAMMAR_REFLECTION)).toMatchObject({
      enumerable: false,
      configurable: true,
    })

    const second = { nodes: [{ type: 'Other', tags: [] }] }
    attachGrammarReflection(grammar, second)
    expect(grammarReflectionOf(grammar)).toBe(second)
    expect(grammarReflectionOf({})).toBeUndefined()
    expect(grammarReflectionSource(first)).toBe('{ nodes: [{"type":"Entry","tags":["Root"]}] }')
  })
})
