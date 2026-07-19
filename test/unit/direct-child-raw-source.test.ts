/**
 * A direct node builder returns an application object, while an enclosing
 * structural node still needs the exact source span for its raw CST view. This
 * covers a multi-token direct node, trivia around it, a rolled-back choice arm,
 * and expect() recovery in both the interpreter and macro output.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  choice, compose, cstBuildHost, expect as required, literal, node, oneOrMore, parse, parser, regex, rules, run,
  sequence, trivia,
} from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

type Result = { child: unknown; raw: unknown; children?: readonly unknown[]; rawChildren?: readonly unknown[] }
type RuleFn = (input: string, pos: number, ctx: { trackLines?: boolean; _errors?: unknown[] }) =>
  { ok: boolean; value?: Result; span: { start: number; end: number } }

const ws = trivia(oneOrMore(choice(
  regex(/[ \t\n]+/),
  regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
)))
const Color = node('Color', sequence(literal('re'), literal('d')), () => ({ kind: 'color' }))
const InternalColor = node('InternalColor', parser({ trivia: ws }, sequence(literal('r'), literal('ed'))), () => ({ kind: 'internal-color' }))
const summarize = (children: readonly unknown[], raw: readonly unknown[]): Result => ({ child: children[1], raw: raw[1], children, rawChildren: raw })
const Call = node('Call', parser({ trivia: ws }, choice(
  sequence(literal('fn('), Color, literal('!')),
  sequence(literal('fn('), Color, literal(','), literal('blue'), literal(')')),
)), (children, _fields, _span, raw) => summarize(children, raw))
const RecoveringCall = node('RecoveringCall', sequence(
  literal('fn('), Color, required(literal(')')),
), (children, _fields, _span, raw) => summarize(children, raw))
const InternalCall = node('InternalCall', parser({ trivia: ws }, sequence(
  literal('fn('), InternalColor, literal(','), literal('blue'), literal(')'),
)), (children, _fields, _span, raw) => summarize(children, raw))
const CstOuter = node('CstOuter', Color)
const directRules = rules(g => {
  const Direct = node('Direct', literal('x'), () => ({ kind: 'direct' }))
  const Root = node('Root', g.Direct)
  return { Direct, Root }
})

const MACRO = `
import { choice, expect, literal, node, oneOrMore, parser, regex, sequence, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(oneOrMore(choice(
  regex(/[ \\t\\n]+/),
  regex(/\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\//),
)))
const Color = node('Color', sequence(literal('re'), literal('d')), () => ({ kind: 'color' }))
const InternalColor = node('InternalColor', parser({ trivia: ws }, sequence(literal('r'), literal('ed'))), () => ({ kind: 'internal-color' }))
const Call = node('Call', parser({ trivia: ws }, choice(
  sequence(literal('fn('), Color, literal('!')),
  sequence(literal('fn('), Color, literal(','), literal('blue'), literal(')')),
)), (children, _fields, _span, raw) => ({ child: children[1], raw: raw[1], children, rawChildren: raw }))
const RecoveringCall = node('RecoveringCall', sequence(
  literal('fn('), Color, expect(literal(')')),
), (children, _fields, _span, raw) => ({ child: children[1], raw: raw[1], children, rawChildren: raw }))
const InternalCall = node('InternalCall', parser({ trivia: ws }, sequence(
  literal('fn('), InternalColor, literal(','), literal('blue'), literal(')'),
)), (children, _fields, _span, raw) => ({ child: children[1], raw: raw[1], children, rawChildren: raw }))
const CstOuter = node('CstOuter', Color)
`.trim()

let macro: { Call: RuleFn; RecoveringCall: RuleFn; InternalCall: RuleFn; CstOuter: RuleFn }

beforeAll(() => {
  const result = transformMacro(MACRO, 'direct-child-raw-source.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  if (result.code.includes("from 'parseman'")) throw new Error('macro transform did not compile')
  macro = new Function(result.code.replace(/\bconst\b/g, 'var') + '\nreturn { Call, RecoveringCall, InternalCall, CstOuter }')() as typeof macro
})

function assertSource(value: Result | undefined): void {
  expect(value?.child).toEqual({ kind: 'color' })
  expect(value?.raw).toEqual({ _tag: 'leaf', value: 'red', span: { start: 3, end: 6 } })
}

function assertCallShape(value: Result | undefined): void {
  expect(value?.children).toHaveLength(5)
  expect(value?.rawChildren).toHaveLength(5)
  expect(value?.children?.map(child => typeof child === 'object' && child !== null && 'kind' in child ? child : (child as { value: unknown }).value))
    .toEqual(['fn(', { kind: 'color' }, ',', 'blue', ')'])
  expect(value?.rawChildren?.map(child => (child as { value: unknown }).value))
    .toEqual(['fn(', 'red', ',', 'blue', ')'])
}

describe('direct node child raw source', () => {
  const input = 'fn(red /* note */\n  , blue)'

  it('preserves the direct object and its multi-token source after choice rollback', () => {
    const result = run(Call, input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      assertSource(result.value as Result)
      assertCallShape(result.value as Result)
    }
  })

  it('does the same in macro-compiled output', () => {
    const result = macro.Call(input, 0, { trackLines: false })
    expect(result.ok).toBe(true)
    if (result.ok) {
      assertSource(result.value)
      assertCallShape(result.value)
    }
  })

  it('keeps the raw child through expect() recovery', () => {
    const result = parse(RecoveringCall, 'fn(red', { recover: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      assertSource(result.value)
      expect(result.errors).toHaveLength(1)
    }
  })

  it('keeps the raw child through macro expect() recovery', () => {
    const errors: unknown[] = []
    const result = macro.RecoveringCall('fn(red', 0, { trackLines: false, _errors: errors })
    expect(result.ok).toBe(true)
    if (result.ok) assertSource(result.value)
    expect(errors).toHaveLength(1)
  })

  it('preserves a direct node\'s internal trivia as its one opaque raw leaf', () => {
    const input = 'fn(r /*x*/ ed, blue)'
    const assertInternal = (value: Result | undefined) => {
      expect(value?.child).toEqual({ kind: 'internal-color' })
      expect(value?.raw).toEqual({ _tag: 'leaf', value: 'r /*x*/ ed', span: { start: 3, end: 13 } })
      expect(value?.children).toHaveLength(5)
      expect(value?.rawChildren?.map(child => (child as { value: unknown }).value))
        .toEqual(['fn(', 'r /*x*/ ed', ',', 'blue', ')'])
    }
    const interpreted = run(InternalCall, input)
    expect(interpreted.ok).toBe(true)
    if (interpreted.ok) assertInternal(interpreted.value as Result)
    const compiled = macro.InternalCall(input, 0, { trackLines: false })
    expect(compiled.ok).toBe(true)
    if (compiled.ok) assertInternal(compiled.value)
  })

  it('never places a direct AST object inside a positioned CST', () => {
    const assertCst = (value: unknown) => expect(value).toMatchObject({
      _tag: 'node', type: 'CstOuter', children: [{
        _tag: 'node', type: 'Color', children: [
          { _tag: 'leaf', value: 're' }, { _tag: 'leaf', value: 'd' },
        ],
      }],
    })
    const interpreted = run(CstOuter, 'red', { build: cstBuildHost() })
    expect(interpreted.ok).toBe(true)
    if (interpreted.ok) assertCst(interpreted.value)
    const compiled = macro.CstOuter('red', 0, { trackLines: false, build: cstBuildHost() } as never)
    expect(compiled.ok).toBe(true)
    if (compiled.ok) assertCst(compiled.value)
  })

  it('keeps direct-builder ownership across run() and linkable compose(), except for the CST host', () => {
    const customHost = (type: string) => ({ kind: 'host', type })
    const interpreted = run(directRules.Direct, 'x', { build: customHost })
    expect(interpreted.ok).toBe(true)
    if (interpreted.ok) expect(interpreted.value).toEqual({ kind: 'direct' })

    const composed = compose([directRules])
    const linked = composed.Direct!('x', 0, { build: customHost })
    expect(linked.ok).toBe(true)
    expect(linked.value).toEqual({ kind: 'direct' })

    const cst = composed.Root!('x', 0, { build: cstBuildHost() })
    expect(cst.ok).toBe(true)
    expect(cst.value).toMatchObject({
      _tag: 'node', type: 'Root', children: [{ _tag: 'node', type: 'Direct' }],
    })
  })
})
