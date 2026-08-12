import { describe, expect, it } from 'vitest'
import {
  compile, expect as expectTerm, field, literal, node, optional, parse, parser, regex, sequence,
} from '../../src/index.ts'
import type { ParseContext, ParseResult } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { rollbackScannedTriviaAt } from '../../src/combinators/trivia-skip.ts'

const emptyValue = () => ({ kind: 'empty' as const })
const buildRoot = (
  children: ReadonlyArray<unknown>, fields: Record<string, unknown> | undefined,
  span: { start: number; end: number }, rawChildren: ReadonlyArray<unknown>, triviaLog: readonly number[],
) => ({ children: [...children], fields, span, rawChildren: [...rawChildren], triviaLog: [...triviaLog] })
const space = regex(/ +/)
const Empty = node('Empty', optional(literal('x')), emptyValue)
const Root = parser(
  { trivia: space, captureTrivia: true },
  node('Root', sequence(literal('a'), field('tail', Empty)), buildRoot),
)
const prog = encodeTable({ Root })

function assertGolden(result: ParseResult<unknown>, input: string): void {
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const root = result.value as ReturnType<typeof buildRoot>
  expect(root.children).toHaveLength(2)
  expect(root.children[1]).toEqual({ kind: 'empty' })
  expect(root.rawChildren).toHaveLength(2)
  expect(root.fields).toEqual({
    tail: { value: { kind: 'empty' }, span: { start: input.length, end: input.length } },
  })
  expect(root.triviaLog).toEqual([])
  expect(result.span).toEqual({ start: 0, end: 1 })
}

describe('zero-width sequence effects after ambient trivia', () => {
  it('compacts only the ambient trivia ranges', () => {
    const scanError = new Error('scan')
    const childError = new Error('child')
    const ctx = {
      trackLines: false,
      _cstLeaves: ['before', 'child'],
      _cstRawChildren: ['before-raw', 'child-raw'],
      _cstTriviaLog: [0, 1, 0, 10, 11, 1, 20, 21, 2],
      _fields: [{ name: 'before' }, { name: 'child' }],
      _errors: [scanError, childError],
      _triviaLog: [0, 1, 10, 11, 20, 21],
      _rootTriviaLog: [0, 1, 0, 1, 0, 10, 11, 10, 11, 1, 20, 21, 20, 21, 2],
    } as unknown as ParseContext
    rollbackScannedTriviaAt(ctx, 3, 6, 2, 4, 5, 10)
    expect(ctx._cstTriviaLog).toEqual([0, 1, 0, 20, 21, 2])
    expect(ctx._triviaLog).toEqual([0, 1, 20, 21])
    expect(ctx._rootTriviaLog).toEqual([0, 1, 0, 1, 0, 20, 21, 20, 21, 2])
    expect(ctx._cstLeaves).toEqual(['before', 'child'])
    expect(ctx._fields?.map(f => f.name)).toEqual(['before', 'child'])
    expect(ctx._errors).toEqual([scanError, childError])
  })

  for (const input of ['a', 'a ']) {
    it(`preserves the child node and field for ${JSON.stringify(input)}`, () => {
      assertGolden(parse(Root, input), input)
      assertGolden(compile(Root).parse(input), input)
      assertGolden(execRules(prog).Root!(input, 0, { trackLines: false }), input)
      assertGolden(tableRules({ ...prog, asm: [] }).Root!(input, 0, { trackLines: false }), input)
      assertGolden(tableRules(prog).Root!(input, 0, { trackLines: false }), input)
    })
  }

  it('preserves a zero-width recovery error after the ambient scan', () => {
    const grammar = parser(
      { trivia: space },
      node('Recovered', sequence(literal('a'), expectTerm(literal('x')))),
    )
    const recoveryProgram = encodeTable({ Entry: grammar })
    const entries = [
      execRules(recoveryProgram).Entry!,
      tableRules({ ...recoveryProgram, asm: [] }).Entry!,
      tableRules(recoveryProgram).Entry!,
    ]
    for (const input of ['a', 'a ']) {
      const expectedErrors: unknown[] = []
      const expected = grammar.parse(input, 0, {
        trackLines: false, _tolerant: true, _errors: expectedErrors,
      } as unknown as ParseContext)
      expect(expected.ok).toBe(true)
      expect(expectedErrors).toHaveLength(1)
      for (const entry of entries) {
        const errors: unknown[] = []
        const actual = entry(input, 0, {
          trackLines: false, _tolerant: true, _errors: errors,
        } as unknown as ParseContext)
        expect(actual).toEqual(expected)
        expect(errors).toEqual(expectedErrors)
      }
      const compiledErrors: unknown[] = []
      expect(compile(grammar, undefined, { recovery: true }).parseWithContext(input, {
        trackLines: false, _tolerant: true, _errors: compiledErrors,
      } as unknown as ParseContext, 0)).toEqual(expected)
      expect(compiledErrors).toEqual(expectedErrors)
    }
  })
})
