import { describe, expect, it } from 'vitest'
import {
  choice,
  literal,
  node,
  optional,
  parseDoc,
  regex,
  rules,
  run,
  sepBy,
  sequence,
  type Combinator,
} from '../../src/index.ts'
import type { CSTChild, CSTNode } from '../../src/cst/types.ts'
import type { Registry, RuleFn } from '../../src/functional/doc.ts'

function cst(type: string) {
  return (
    children: readonly unknown[],
    _fields: unknown,
    span: { start: number; end: number },
    _raw: readonly unknown[],
    _trivia: readonly number[],
    state: unknown,
  ): CSTNode => ({
    _tag: 'node',
    type,
    span: { start: span.start, end: span.end },
    state,
    children: [...children] as CSTChild[],
  })
}

const registryOf = <N,>(grammar: Record<string, Combinator<unknown>>) =>
  grammar as unknown as Registry<N>

describe('run() driver edges', () => {
  it('grows a tracked document span across multiline trailing trivia', () => {
    const entry: RuleFn<unknown> = (_input, _pos, ctx) => {
      expect(ctx.state).toEqual({ dialect: 'test' })
      expect(ctx._grammarCoverage).toBe(coverage)
      expect(ctx._grammarTrace).toBe(trace)
      return {
        ok: true,
        value: 'x',
        span: {
          start: 0,
          end: 1,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 2,
        },
      }
    }
    const coverage = () => {}
    const trace = { write: () => {} }
    const result = run(entry, 'x \n  ', {
      state: { dialect: 'test' },
      trivia: regex(/[ \n]+/),
      instrumentation: { _grammarCoverage: coverage, _grammarTrace: trace },
    })
    expect(result.span).toEqual({
      start: 0,
      end: 5,
      startLine: 1,
      startColumn: 1,
      endLine: 2,
      endColumn: 3,
    })
    expect(result.unconsumedFrom).toBeNull()
  })

  it('does not grow for a failing or zero-width tail and validates non-rules precisely', () => {
    const entry: RuleFn<unknown> = () => ({
      ok: true,
      value: 'x',
      span: { start: 0, end: 1 },
    })
    expect(run(entry, 'x!', { trivia: literal(' ') })).toMatchObject({
      span: { start: 0, end: 1 },
      unconsumedFrom: 1,
    })
    expect(run(entry, 'x!', { trivia: literal('') })).toMatchObject({
      span: { start: 0, end: 1 },
      unconsumedFrom: 1,
    })
    expect(() => run(null as never, '')).toThrow(/start production is null/)
    expect(() => run(42 as never, '')).toThrow(/start production is number/)
  })

  it('leaves trailing trivia untouched after a hard top-level failure', () => {
    const failed: RuleFn<unknown> = () => ({
      ok: false,
      expected: ['entry'],
      span: { start: 0, end: 0 },
    })
    expect(run(failed, '   ', { trivia: regex(/ +/) })).toMatchObject({
      ok: false,
      expected: ['entry'],
      span: { start: 0, end: 0 },
      unconsumedFrom: null,
    })
  })
})

describe('parseDoc() driver edges', () => {
  it('uses explicit trailing trivia for combinator roots and reports real junk after it', () => {
    const Root = node('Root', literal('x'), cst('Root'))
    const registry = registryOf<CSTNode>({ Root })

    expect(parseDoc(registry, 'Root', 'x   ', { trivia: regex(/ +/) }).unconsumedFrom).toBeNull()
    expect(parseDoc(registry, 'Root', 'x   !', { trivia: regex(/ +/) }).unconsumedFrom).toBe(4)
    expect(parseDoc(registry, 'Root', 'x   ', { trivia: literal('') }).unconsumedFrom).toBe(1)
    expect(() => parseDoc(registry, 'Missing', '')).toThrow("No rule 'Missing' in registry")
  })

  it('preserves embedded recovery errors when an unrelated subtree is reused', () => {
    const grammar = rules(self => ({
      List: node(
        'List',
        sequence(literal('['), optional(sepBy(self.Value, literal(','))), literal(']')),
        cst('List'),
      ),
      Value: node('Value', choice(self.Num, self.List), cst('Value')),
      Num: node('Num', regex(/[0-9]+/), cst('Num')),
    }))
    const registry = registryOf<CSTNode>(grammar)
    const broken = parseDoc(registry, 'List', '[1,$$,2]', {
      tolerant: true,
      structuralReuse: true,
    })
    expect(broken.errors).toMatchObject([
      { _tag: 'parseError', span: { start: 3, end: 5 } },
    ])

    const edited = broken.edit(6, 7, '3')
    expect(edited.input).toBe('[1,$$,3]')
    expect(edited.errors).toMatchObject([
      { _tag: 'parseError', span: { start: 3, end: 5 } },
    ])
  })

  it('returns a null tree and one diagnostic for a hard root failure', () => {
    const failed: RuleFn<CSTNode> = () => ({
      ok: false,
      expected: ['root'],
      span: { start: 2, end: 2 },
    })
    const doc = parseDoc({ Root: failed }, 'Root', 'xx')
    expect(doc.tree).toBeNull()
    expect(doc.errors).toEqual([
      { _tag: 'parseError', span: { start: 2, end: 2 }, expected: ['root'] },
    ])
    expect(doc.unconsumedFrom).toBeNull()
  })
})
