/**
 * A successful zero-width sequence term still owns every effect its parser
 * produced. Only the ambient trivia scanned before that term is speculative.
 *
 * Regression (0.47.0): sequence took one mark before both operations and used
 * it when `end <= scanEnd`. A nullable node at EOF therefore vanished from its
 * parent's CST together with its field, while a zero-width recovery lost the
 * error it had deliberately emitted. The real CSS symptom was an empty custom
 * property value: `a{--x:}` built `CustomValue` at [8, 8], then erased it.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  compile, expect as expectTerm, field, literal, node, optional, parse, parser,
  regex, sequence,
} from '../../src/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import type { Combinator, ParseContext, ParseResult } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { AssemblyCache, tableRules } from '../../src/table/assemble.ts'
import { expandCompact } from '../../src/table/program.ts'
import { rollbackScannedTriviaAt } from '../../src/combinators/trivia-skip.ts'

const emptyValue = () => ({ kind: 'empty' as const })
const buildRoot = (
  children: ReadonlyArray<unknown>,
  fields: Record<string, unknown> | undefined,
  span: { start: number; end: number },
  rawChildren: ReadonlyArray<unknown>,
  triviaLog: readonly number[],
) => ({ children: [...children], fields, span, rawChildren: [...rawChildren], triviaLog: [...triviaLog] })

const space = regex(/ +/)
const Empty = node('Empty', optional(literal('x')), emptyValue)
const Root = parser(
  { trivia: space, captureTrivia: true },
  node('Root', sequence(literal('a'), field('tail', Empty)), buildRoot),
)
const rootProgram = encodeTable({ Root })
const referenceRoot = execRules(rootProgram).Root!
const emittedRoot = tableRules(rootProgram).Root!

type Entry = (input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>
let macroRoot: Entry

const MACRO_CODE = `
import { field, literal, node, optional, parser, regex, sequence } from 'parseman' with { type: 'macro' }
const space = regex(/ +/)
const Empty = node('Empty', optional(literal('x')), () => ({ kind: 'empty' }))
export const Root = parser(
  { trivia: space, captureTrivia: true },
  node('Root', sequence(literal('a'), field('tail', Empty)),
    (children, fields, span, rawChildren, triviaLog) =>
      ({ children: [...children], fields, span, rawChildren: [...rawChildren], triviaLog: [...triviaLog] })),
)
`.trim()

beforeAll(async () => {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const transformed = transformMacro(MACRO_CODE, 'nullable-node-trivia-rollback.ts', new Set(['parseman']))
  if (!transformed) throw new Error('macro transform returned null')
  if (transformed.code.includes("from 'parseman'")) throw new Error('macro did not compile')
  macroRoot = evalMacroModule<Entry>(transformed.code, 'Root')
})

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
  // The zero-width term does not consume the gap in front of it. Its node and
  // field survive; the unowned gap does not become this node's trivia.
  expect(root.triviaLog).toEqual([])
  expect(result.span).toEqual({ start: 0, end: 1 })
}

describe('nullable node after an ambient trivia boundary', () => {
  it('compacts only the ambient trivia slice and leaves later child effects in place', () => {
    const scanError = new Error('scan-owned sentinel')
    const childError = new Error('child-owned sentinel')
    const ctx = {
      trackLines: false,
      _cstLeaves: ['before', 'child'],
      _cstRawChildren: ['before-raw', 'child-raw'],
      _cstTriviaLog: [0, 1, 0, 10, 11, 1, 20, 21, 2],
      _fields: [
        { name: 'before', value: 1, span: { start: 0, end: 1 } },
        { name: 'child', value: 2, span: { start: 2, end: 2 } },
      ],
      _errors: [scanError, childError],
      _triviaLog: [0, 1, 10, 11, 20, 21],
      _rootTriviaLog: [0, 1, 0, 1, 0, 10, 11, 10, 11, 1, 20, 21, 20, 21, 2],
    } as unknown as ParseContext

    rollbackScannedTriviaAt(ctx, 3, 6, 2, 4, 5, 10)

    expect(ctx._cstTriviaLog).toEqual([0, 1, 0, 20, 21, 2])
    expect(ctx._triviaLog).toEqual([0, 1, 20, 21])
    expect(ctx._rootTriviaLog).toEqual([0, 1, 0, 1, 0, 20, 21, 20, 21, 2])
    expect(ctx._cstLeaves).toEqual(['before', 'child'])
    expect(ctx._cstRawChildren).toEqual(['before-raw', 'child-raw'])
    expect(ctx._fields?.map(f => f.name)).toEqual(['before', 'child'])
    expect(ctx._errors).toEqual([scanError, childError])
  })

  it('uses the emitted diagnostic assembly for the low-level table program', () => {
    const assembly = new AssemblyCache(expandCompact(rootProgram)).for({
      hostCst: false,
      hostReadsChildren: true,
      trackLines: false,
      tolerant: false,
      coverage: false,
      probe: false,
    })
    expect(assembly.emitRefusal).toBeUndefined()
  })

  for (const input of ['a', 'a ']) {
    it(`interpreter keeps the zero-width node and field for ${JSON.stringify(input)}`, () => {
      assertGolden(parse(Root, input), input)
    })

    it(`runtime compile keeps the zero-width node and field for ${JSON.stringify(input)}`, () => {
      assertGolden(compile(Root).parse(input), input)
    })

    it(`actual macro artifact keeps the zero-width node and field for ${JSON.stringify(input)}`, () => {
      assertGolden(macroRoot(input, 0, { trackLines: false }), input)
    })

    it(`reference table keeps the zero-width node and field for ${JSON.stringify(input)}`, () => {
      assertGolden(referenceRoot(input, 0, { trackLines: false }), input)
    })

    it(`emitted diagnostic assembly keeps the zero-width node and field for ${JSON.stringify(input)}`, () => {
      assertGolden(emittedRoot(input, 0, { trackLines: false }), input)
    })
  }
})

function recoveryGrammar(): Combinator<unknown> {
  return parser(
    { trivia: space },
    node('Recovered', sequence(literal('a'), expectTerm(literal('x')))),
  )
}

describe('zero-width recovery is a committed child effect, not scanned trivia', () => {
  for (const input of ['a', 'a ']) {
    it(`interpreter and compile retain the recovery error for ${JSON.stringify(input)}`, () => {
      const grammar = recoveryGrammar()
      const iErrors: unknown[] = []
      const cErrors: unknown[] = []
      const iCtx = { trackLines: false, _tolerant: true, _errors: iErrors } as unknown as ParseContext
      const cCtx = { trackLines: false, _tolerant: true, _errors: cErrors } as unknown as ParseContext
      const interpreted = grammar.parse(input, 0, iCtx)
      const compiled = compile(grammar, undefined, { recovery: true }).parseWithContext(input, cCtx, 0)
      const program = encodeTable({ Entry: grammar })
      const eErrors: unknown[] = []
      const tErrors: unknown[] = []
      const eCtx = { trackLines: false, _tolerant: true, _errors: eErrors } as unknown as ParseContext
      const tCtx = { trackLines: false, _tolerant: true, _errors: tErrors } as unknown as ParseContext
      const reference = execRules(program).Entry!(input, 0, eCtx)
      const emitted = tableRules(program).Entry!(input, 0, tCtx)
      expect(interpreted.ok).toBe(true)
      expect(compiled).toEqual(interpreted)
      expect(reference).toEqual(interpreted)
      expect(emitted).toEqual(interpreted)
      expect(iErrors).toHaveLength(1)
      expect(cErrors).toEqual(iErrors)
      expect(eErrors).toEqual(iErrors)
      expect(tErrors).toEqual(iErrors)
    })
  }
})
